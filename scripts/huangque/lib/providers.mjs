import { readFile } from "node:fs/promises";
import { isLocalControlError, safeFetch } from "./http.mjs";
import { jsonStructureWithinBudget } from "./adapters.mjs";

function asIso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeHit(provider, task, value, discoveredAt, kind, extraEvidence = {}) {
  return {
    provider,
    queryId: task.id,
    query: task.query,
    dimensions: task.dimensions || {},
    title: String(value.title || value.name || "").trim().slice(0, 500),
    url: String(value.url || "").trim().slice(0, 4_096),
    snippet: String(value.snippet || value.content || value.description || "").trim().slice(0, 4_000),
    publishedAt: asIso(value.publishedAt || value.date || value.timestamp),
    discoveredAt,
    evidence: {
      kind,
      ...extraEvidence,
    },
  };
}

function result(status, provider, hits = [], warnings = [], metadata = {}) {
  return {
    schemaVersion: "huangque.discovery-provider-result.v1",
    provider,
    providerStatus: status,
    hits,
    exhausted: !(Number.isInteger(metadata.unattemptedTaskCount) && metadata.unattemptedTaskCount > 0),
    warnings,
    metadata,
  };
}

export function baiduQueryUnits(value) {
  return [...String(value || "")].reduce((total, character) => total + ((character.codePointAt(0) || 0) > 0x7f ? 2 : 1), 0);
}

export function truncateBaiduQuery(value, maxUnits = 72) {
  let output = "";
  let units = 0;
  for (const character of String(value || "").trim()) {
    const next = (character.codePointAt(0) || 0) > 0x7f ? 2 : 1;
    if (units + next > maxUnits) break;
    output += character;
    units += next;
  }
  return output.trim();
}

export function buildBaiduRequest(query, { topK = 20, city = null, recentWindow = "now-6M/d" } = {}) {
  const safeQuery = truncateBaiduQuery(query);
  if (!safeQuery) throw new TypeError("百度查询不能为空");
  const range = {
    page_time: { gte: recentWindow, lt: "now/d" },
  };
  if (city && !/^(?:全国|中国|all)$/i.test(String(city).trim())) range.geo = { city: [String(city).trim()] };
  return {
    messages: [{ role: "user", content: safeQuery }],
    search_source: "baidu_search_v2",
    resource_type_filter: [{ type: "web", top_k: Math.min(50, Math.max(1, Number(topK) || 20)) }],
    search_filter: { range },
    safe_search: true,
  };
}

function isBaiduUpstreamDailyQuotaCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return code.includes("QUOTA") && code.includes("DAILY");
}

function isBaiduErrorPayload(payload, responseOk) {
  if (!responseOk || payload?.error || payload?.error_code) return true;
  if (!Object.prototype.hasOwnProperty.call(payload || {}, "code")) return false;
  const code = String(payload.code ?? "").trim();
  if (!code) return false;
  if (/^\d+$/.test(code)) return Number(code) >= 400;
  return !new Set(["OK", "SUCCESS"]).has(code.toUpperCase());
}

function redactBaiduText(value, apiKey) {
  let output = String(value ?? "");
  const exactSecret = String(apiKey || "");
  if (exactSecret) output = output.split(exactSecret).join("[REDACTED]");
  return output
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bbce-v3\/[^\s,;"'<>]+/gi, "[REDACTED]");
}

function redactBaiduDiagnostic(value, apiKey) {
  return redactBaiduText(value, apiKey).slice(0, 2_000);
}

function containsBaiduCredential(value, apiKey) {
  const input = String(value ?? "");
  return redactBaiduText(input, apiKey) !== input;
}

function redactBaiduOutput(value, apiKey) {
  if (typeof value === "string") return redactBaiduText(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => redactBaiduOutput(item, apiKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactBaiduOutput(item, apiKey)]));
  }
  return value;
}

export async function runBaiduProvider(tasks, {
  apiKey = process.env.HUANGQUE_BAIDU_API_KEY,
  endpoint = process.env.HUANGQUE_BAIDU_ENDPOINT || "https://qianfan.baidubce.com/v2/ai_search/web_search",
  maxQueries = Number(process.env.HUANGQUE_BAIDU_DAILY_BUDGET || 40),
  topK = 20,
  now = new Date(),
  fetchOptions = {},
  reserveRequest = null,
} = {}) {
  if (!apiKey) return result("not_configured", "baidu", [], ["HUANGQUE_BAIDU_API_KEY 未配置；未抓取百度搜索结果页，其他 Provider 继续运行。"]);
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { return result("failed", "baidu", [], ["百度 API endpoint 不是有效 URL"]); }
  if (endpointUrl.protocol !== "https:" || endpointUrl.hostname !== "qianfan.baidubce.com") {
    return result("failed", "baidu", [], ["为避免凭据外发，百度 API Key 只允许发送到 qianfan.baidubce.com"]);
  }
  const discoveredAt = new Date(now).toISOString();
  const hits = [];
  const warnings = [];
  const completedTaskIds = [];
  const failedTaskIds = [];
  let requestCount = 0;
  let dailyBudget = null;
  let budgetExhausted = false;
  let upstreamQuotaExhausted = false;
  let haltedReason = null;
  let queryCount = 0;
  const selectedTasks = tasks.slice(0, Math.max(0, maxQueries));
  for (const task of selectedTasks) {
    queryCount += 1;
    try {
      const upstreamBeforeRequest = fetchOptions.beforeRequest;
      let initialRequestAdmitted = false;
      const response = await safeFetch(endpoint, {
        ...fetchOptions,
        beforeRequest: async (request) => {
          const requestPolicy = upstreamBeforeRequest ? await upstreamBeforeRequest(request) : null;
          if (request.redirectCount !== 0 || initialRequestAdmitted) return requestPolicy;
          initialRequestAdmitted = true;
          if (reserveRequest) {
            try {
              dailyBudget = await reserveRequest({ provider: "baidu", taskId: task.id, at: discoveredAt });
            } catch (error) {
              if (isLocalControlError(error)) throw error;
              throw Object.assign(new Error(`百度每日请求预算无法安全预留：${error.message}`), { code: "BAIDU_BUDGET_RESERVATION_FAILED" });
            }
            if (!dailyBudget?.granted) {
              throw Object.assign(new Error(`百度每日请求预算已用尽（${dailyBudget?.used || 0}/${dailyBudget?.limit || maxQueries}），剩余查询留待下一运行日。`), { code: "BAIDU_DAILY_BUDGET_EXHAUSTED" });
            }
          }
          requestCount += 1;
          return requestPolicy;
        },
        method: "POST",
        headers: {
          ...(fetchOptions.headers || {}),
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildBaiduRequest(task.query, {
          topK,
          city: task.dimensions?.baiduCity || task.dimensions?.city || null,
        })),
        maxBytes: 3_000_000,
      });
      let payload;
      try {
        if (!jsonStructureWithinBudget(response.body, 100_000)) throw new Error("百度响应结构超过安全上限");
        payload = JSON.parse(response.body);
      } catch {
        throw new Error(`百度返回非 JSON（HTTP ${response.status}）`);
      }
      if (isBaiduErrorPayload(payload, response.ok)) {
        const code = payload.error_code ?? payload.code ?? response.status;
        const safeCode = redactBaiduDiagnostic(code, apiKey);
        const safeMessage = redactBaiduDiagnostic(payload.error_msg ?? payload.message ?? response.status, apiKey);
        const error = new Error(`百度 API 错误 ${safeCode}：${safeMessage}`);
        if (isBaiduUpstreamDailyQuotaCode(code)) error.code = "BAIDU_UPSTREAM_DAILY_QUOTA_EXHAUSTED";
        throw error;
      }
      const references = payload.references || payload.result?.references || [];
      const expectedMaximum = Math.min(50, Math.max(1, Number(topK) || 20));
      if (!Array.isArray(references) || references.length > expectedMaximum) {
        throw Object.assign(new Error(`百度 references 超过请求上限 ${expectedMaximum}`), { code: "PROVIDER_RESPONSE_LIMIT_EXCEEDED" });
      }
      for (const reference of references) {
        if (!reference?.url) continue;
        if (containsBaiduCredential(reference.url, apiKey)) {
          warnings.push(`${task.id}：百度结果 URL 含疑似凭据回显，已安全丢弃。`);
          continue;
        }
        hits.push(normalizeHit("baidu", task, reference, discoveredAt, "search_result", {
          requestId: payload.request_id || response.headers["x-request-id"] || null,
          score: reference.rerank_score ?? null,
          authorityScore: reference.authority_score ?? null,
          region: task.dimensions?.region || task.dimensions?.province || task.dimensions?.city || null,
        }));
      }
      completedTaskIds.push(task.id);
    } catch (error) {
      if (isLocalControlError(error)) throw error;
      const safeErrorMessage = redactBaiduDiagnostic(error.message, apiKey);
      if (["BAIDU_DAILY_BUDGET_EXHAUSTED", "BAIDU_BUDGET_RESERVATION_FAILED"].includes(error.code)) {
        warnings.push(safeErrorMessage);
        budgetExhausted = true;
        haltedReason = error.code;
        break;
      }
      if (error.code === "BAIDU_UPSTREAM_DAILY_QUOTA_EXHAUSTED") {
        failedTaskIds.push(task.id);
        warnings.push(`${task.id}：${safeErrorMessage}；本轮百度任务已熔断，剩余任务留待额度恢复后重试。`);
        upstreamQuotaExhausted = true;
        haltedReason = error.code;
        break;
      }
      failedTaskIds.push(task.id);
      warnings.push(`${task.id}：${safeErrorMessage}`);
    }
  }
  const providerStatus = failedTaskIds.length > 0 || haltedReason
    ? completedTaskIds.length > 0 ? "partial" : "failed"
    : "ok";
  return redactBaiduOutput(result(providerStatus, "baidu", hits, warnings, {
    requestCount,
    queryCount,
    selectedTaskCount: selectedTasks.length,
    completedTaskIds,
    failedTaskIds,
    budgetExhausted,
    upstreamQuotaExhausted,
    haltedReason,
    unattemptedTaskCount: Math.max(0, selectedTasks.length - queryCount),
    dailyBudget: dailyBudget ? {
      day: dailyBudget.day,
      used: dailyBudget.used,
      limit: dailyBudget.limit,
      remaining: dailyBudget.remaining,
    } : null,
  }), apiKey);
}

export function extractSitePattern(query) {
  const match = String(query || "").match(/(?:^|\s)site:([^\s"']+)/i);
  if (!match) return null;
  const raw = match[1].replace(/^https?:\/\//i, "").replace(/^\*\./, "").replace(/\/+$/, "");
  if (!raw || raw.includes("..")) return null;
  return `${raw}/*`;
}

export function parseCommonCrawlNdjson(text, maximumRows = 100) {
  const rows = [];
  const input = String(text || "");
  let start = 0;
  let index = 0;
  while (start <= input.length) {
    const newline = input.indexOf("\n", start);
    const end = newline < 0 ? input.length : newline;
    const line = input.slice(start, end).replace(/\r$/, "");
    if (!line.trim()) {
      if (newline < 0) break;
      start = newline + 1;
      continue;
    }
    try {
      if (rows.length >= maximumRows) throw new TypeError(`Common Crawl 返回行数超过请求上限 ${maximumRows}`);
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new TypeError(`Common Crawl 第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
    index += 1;
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

export async function runCommonCrawlProvider(tasks, {
  maxQueries = 6,
  maxResultsPerQuery = 30,
  now = new Date(),
  fetchOptions = {},
} = {}) {
  const discoveredAt = new Date(now).toISOString();
  const eligible = tasks.map((task) => ({ task, pattern: extractSitePattern(task.query) })).filter((item) => item.pattern);
  if (eligible.length === 0) return result("not_applicable", "common_crawl", [], ["本轮查询没有受控 site: 域名；Common Crawl 不执行正文关键词搜索。"], { completedTaskIds: [], failedTaskIds: [], requestCount: 0, eligibleQueries: 0 });
  let indexes;
  try {
    const response = await safeFetch("https://index.commoncrawl.org/collinfo.json", { ...fetchOptions, maxBytes: 500_000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    indexes = JSON.parse(response.body);
  } catch (error) {
    if (isLocalControlError(error)) throw error;
    return result("failed", "common_crawl", [], [`索引目录读取失败：${error.message}`], { completedTaskIds: [], failedTaskIds: eligible.map(({ task }) => task.id) });
  }
  const current = Array.isArray(indexes) ? indexes[0] : null;
  if (!current?.id || !(current["cdx-api"] || current.cdxApi)) {
    return result("failed", "common_crawl", [], ["索引目录缺少 id 或 cdx-api"], { completedTaskIds: [], failedTaskIds: eligible.map(({ task }) => task.id) });
  }
  const cdxApi = current["cdx-api"] || current.cdxApi;
  const hits = [];
  const warnings = [];
  const completedTaskIds = [];
  const failedTaskIds = [];
  let requestCount = 1;
  for (const { task, pattern } of eligible.slice(0, Math.max(0, maxQueries))) {
    const url = new URL(cdxApi);
    url.searchParams.set("url", pattern);
    url.searchParams.set("output", "json");
    url.searchParams.append("filter", "=status:200");
    url.searchParams.append("filter", "=mime:text/html");
    url.searchParams.set("fl", "timestamp,url,mime,status,digest");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("limit", String(Math.min(100, Math.max(1, maxResultsPerQuery))));
    try {
      const response = await safeFetch(url.toString(), { ...fetchOptions, maxBytes: 2_000_000 });
      requestCount += 1;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const expectedMaximum = Math.min(100, Math.max(1, Number(maxResultsPerQuery) || 30));
      const rows = parseCommonCrawlNdjson(response.body, expectedMaximum);
      completedTaskIds.push(task.id);
      for (const row of rows) {
        if (!row?.url) continue;
        hits.push(normalizeHit("common_crawl", task, {
          title: row.url,
          url: row.url,
          snippet: `Common Crawl ${current.id} URL 索引记录`,
          timestamp: /^\d{14}$/.test(String(row.timestamp || ""))
            ? `${String(row.timestamp).slice(0, 4)}-${String(row.timestamp).slice(4, 6)}-${String(row.timestamp).slice(6, 8)}T${String(row.timestamp).slice(8, 10)}:${String(row.timestamp).slice(10, 12)}:${String(row.timestamp).slice(12, 14)}Z`
            : null,
        }, discoveredAt, "archive_index", {
          archive: current.id,
          digest: row.digest || null,
          requestUrl: url.toString(),
        }));
      }
    } catch (error) {
      if (isLocalControlError(error)) throw error;
      failedTaskIds.push(task.id);
      warnings.push(`${task.id}：${error.message}`);
    }
  }
  const providerStatus = failedTaskIds.length > 0
    ? completedTaskIds.length > 0 ? "partial" : "failed"
    : "ok";
  return result(providerStatus, "common_crawl", hits, warnings, {
    indexId: current.id,
    requestCount,
    eligibleQueries: eligible.length,
    executedQueries: Math.min(eligible.length, maxQueries),
    completedTaskIds,
    failedTaskIds,
    limitation: "URL 索引证据，不是网页正文关键词搜索",
  });
}

export async function runPublicCatalogProvider(tasks, {
  catalogPath,
  catalog,
  channelPlanPath = null,
  channelPlan = null,
  now = new Date(),
} = {}) {
  const payload = catalog || JSON.parse(await readFile(catalogPath, "utf8"));
  if (payload?.schemaVersion !== "huangque.public-catalog.v1" || !Array.isArray(payload.entries)) {
    return result("failed", "official_catalog", [], ["官方目录格式无效"]);
  }
  let watchlist = channelPlan;
  if (!watchlist && channelPlanPath) {
    try { watchlist = JSON.parse(await readFile(channelPlanPath, "utf8")); }
    catch (error) { return result("failed", "official_catalog", [], [`重点企业清单无法读取：${error.message}`]); }
  }
  if (watchlist && (watchlist.schemaVersion !== "huangque.source-channel-plan.v1" || !Array.isArray(watchlist.targetInventory?.employers))) {
    return result("failed", "official_catalog", [], ["重点企业清单格式无效"]);
  }
  const catalogHosts = new Set(payload.entries.map((entry) => {
    try { return new URL(entry.url).hostname.toLowerCase(); } catch { return null; }
  }).filter(Boolean));
  const employerEntries = (watchlist?.targetInventory?.employers || [])
    .filter((target) => !(target.match?.hosts || []).some((host) => catalogHosts.has(String(host).toLowerCase())))
    .map((target) => ({
      id: `employer-watchlist:${target.id}`,
      title: `${target.name}官方招聘`,
      url: target.audit.officialRecruitmentUrl,
      snippet: `${target.name}由版本化重点企业清单提供的官方公开招聘入口；岗位地点以职位记录为准。`,
      publisher: target.name,
      authority: "official_employer",
      region: "全国",
      regionCode: "CN",
      coverageRegions: "job_level_locations_only",
      sourcePage: target.audit.officialRecruitmentUrl,
      evidenceKind: "official_employer_watchlist",
    }));
  const entries = [
    ...payload.entries.map((entry) => ({ ...entry, evidenceKind: "official_directory" })),
    ...employerEntries,
  ];
  const discoveredAt = new Date(now).toISOString();
  const hits = entries.map((entry, index) => normalizeHit("official_catalog", {
    id: `official-catalog:${entry.id || index + 1}`,
    query: `${entry.region || payload.scope || "全国"} 官方招聘目录`,
    dimensions: { catalogEntryId: entry.id || index + 1, region: entry.region || payload.scope || "全国", regionCode: entry.regionCode || null },
  }, entry, discoveredAt, entry.evidenceKind, {
    sourcePage: entry.sourcePage || entry.url,
    authority: entry.authority || null,
    publisher: entry.publisher || null,
    region: entry.region || null,
    regionCode: entry.regionCode || null,
    coverageRegions: entry.coverageRegions || null,
    catalogUpdatedAt: payload.updatedAt || null,
  }));
  return result("ok", "official_catalog", hits, [], {
    catalogUpdatedAt: payload.updatedAt || null,
    entries: hits.length,
    directoryEntries: payload.entries.length,
    employerWatchlistEntries: employerEntries.length,
    inputTaskCount: tasks.length,
  });
}

export function runImportedProvider(importedInput, { now = new Date() } = {}) {
  if (!importedInput) return result("not_configured", "imported", [], ["未提供导入结果"]);
  const discoveredAt = new Date(now).toISOString();
  const queries = Array.isArray(importedInput.queries)
    ? importedInput.queries
    : [{ id: "imported", query: importedInput.query || "", results: importedInput.results || [] }];
  const hits = queries.flatMap((query, queryIndex) => (query.results || []).map((entry, resultIndex) => {
    const supplied = entry?.providerEvidence && typeof entry.providerEvidence === "object"
      && !Array.isArray(entry.providerEvidence) ? entry.providerEvidence : {};
    // Imported results are also used internally by the employer crawler. Keep
    // only the bounded provenance fields needed by deterministic discovery;
    // arbitrary imported objects, credentials and headers never enter source
    // evidence through this adapter.
    const evidence = Object.fromEntries([
      "kind", "authority", "publisher", "sourcePage", "region", "regionCode",
      "coverageRegions", "employerTargetId", "evidenceKind", "parentSourceId",
      "parentUrl", "parentArtifact",
    ].flatMap((key) => Object.hasOwn(supplied, key) ? [[key, supplied[key]]] : []));
    return normalizeHit("imported", {
      id: query.id || `imported:${queryIndex + 1}`,
      query: query.query || "",
      dimensions: query.dimensions || {},
    }, entry, discoveredAt, "imported_result", { ...evidence, rank: entry.rank || resultIndex + 1 });
  }));
  return result("ok", "imported", hits, [], {
    completedTaskIds: queries.map((query, queryIndex) => query.id || `imported:${queryIndex + 1}`),
    failedTaskIds: [],
  });
}

export async function runDiscoveryProviders(tasks, {
  providers = ["official_catalog", "common_crawl", "baidu"],
  catalogPath,
  channelPlanPath,
  importedInput,
  now = new Date(),
  baidu = {},
  commonCrawl = {},
} = {}) {
  const outputs = [];
  for (const provider of providers) {
    if (provider === "official_catalog") outputs.push(await runPublicCatalogProvider(tasks, { catalogPath, channelPlanPath, now }));
    else if (provider === "common_crawl") outputs.push(await runCommonCrawlProvider(tasks, { ...commonCrawl, now }));
    else if (provider === "baidu") outputs.push(await runBaiduProvider(tasks, { ...baidu, now }));
    else if (provider === "imported") outputs.push(runImportedProvider(importedInput, { now }));
    else outputs.push(result("failed", provider, [], [`未知发现 Provider：${provider}`]));
  }
  const grouped = new Map();
  for (const output of outputs) {
    for (const hit of output.hits) {
      const key = `${output.provider}:${hit.queryId}`;
      const group = grouped.get(key) || {
        id: key,
        query: hit.query,
        dimensions: hit.dimensions || {},
        channel: output.provider,
        results: [],
      };
      group.results.push({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        publishedAt: hit.publishedAt,
        rank: hit.evidence?.rank || group.results.length + 1,
        providerEvidence: hit.evidence,
      });
      grouped.set(key, group);
    }
  }
  return {
    schemaVersion: "huangque.discovery-input.v1",
    metadata: {
      project: "黄雀",
      scope: "全国",
      provider: "multi_provider",
      observedAt: new Date(now).toISOString(),
      providerRuns: outputs.map((output) => ({
        provider: output.provider,
        status: output.providerStatus,
        hits: output.hits.length,
        warnings: output.warnings,
        metadata: output.metadata,
      })),
    },
    queries: [...grouped.values()],
  };
}
