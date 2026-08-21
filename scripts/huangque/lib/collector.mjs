import { createHash } from "node:crypto";
import { dedupeJobs, normalizeAdapterPayload } from "./adapters.mjs";
import { fetchRobotsPolicy, robotsAllowsRules, safeFetch } from "./http.mjs";
import { createPublicRecruitmentSession } from "./public-recruitment-session.mjs";

const PUBLIC_RECRUITMENT_PAGE_SIZE = 100;

function publicRecruitmentFixedQuery(candidate) {
  const feishu = candidate.provider === "FeishuRecruitment";
  return {
    keyword: "",
    job_category_id_list: [],
    tag_id_list: [],
    location_code_list: [],
    subject_id_list: [],
    recruitment_id_list: [],
    portal_type: feishu ? 6 : 2,
    job_function_id_list: [],
    storefront_id_list: [],
    job_post_id_list: [],
    ...(feishu ? {} : { portal_entrance: 1 }),
  };
}

function collectionPage(candidate, endpoint, page, sessionHeaders = {}, observedOffset = 0) {
  if (candidate.provider === "ByteDance" || candidate.provider === "FeishuRecruitment") {
    const pageSize = PUBLIC_RECRUITMENT_PAGE_SIZE;
    const feishu = candidate.provider === "FeishuRecruitment";
    return {
      url: endpoint,
      paginated: true,
      pageSize,
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "portal-channel": feishu ? "saas-career" : "office",
        "portal-platform": "pc",
        ...sessionHeaders,
      },
      body: JSON.stringify({
        ...publicRecruitmentFixedQuery(candidate),
        limit: pageSize,
        offset: observedOffset,
      }),
    };
  }
  if (candidate.provider === "BeijingPublicEmployment") {
    return {
      url: endpoint,
      paginated: true,
      pageSize: 100,
      method: "POST",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ ssqs: [], gwlms: [], sgwlms: [], ssnr: "", tjid: ["01"], pageSize: 100, pageNum: page, mkId: 70 }),
    };
  }
  if (candidate.provider === "NCSS") {
    const url = new URL(endpoint);
    const pageSize = 50;
    url.searchParams.set("offset", String((page - 1) * pageSize + 1));
    url.searchParams.set("limit", String(pageSize));
    return { url: url.toString(), paginated: true, pageSize, method: "GET" };
  }
  if (candidate.provider === "Greenhouse") {
    const url = new URL(endpoint);
    // Greenhouse's optional `content=true` payload can exceed ten megabytes on
    // large boards. The job-source engine only needs the bounded listing
    // fields and canonical detail URL; the detail page remains the source of
    // the full description.
    url.searchParams.set("content", "false");
    return { url: url.toString(), paginated: false, pageSize: null, method: "GET" };
  }
  return { url: endpoint, paginated: false, pageSize: null, method: "GET" };
}

const TRANSIENT_COLLECTION_ERRORS = new Set(["FETCH_FAILED", "TIMEOUT", "DNS_FAILURE", "DNS_TIMEOUT"]);
const OFFSET_PAGINATION_PROVIDERS = new Set(["ByteDance", "FeishuRecruitment"]);
const MAX_CURSOR_OFFSET = 50_000_000;
const MAX_CURSOR_GENERATION = 1_000_000_000;
const HTTP_VALIDATOR_SCHEMA_VERSION = "huangque.http-validator.v1";
const MAX_RETRY_AFTER_MS = 2_000;

function safeValidatorHeader(value, maximumLength = 1_024) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function safeEtag(value) {
  const normalized = safeValidatorHeader(value);
  return normalized && /^(?:W\/)?"[^"\r\n]*"$/.test(normalized) ? normalized : null;
}

function safeLastModified(value) {
  const normalized = safeValidatorHeader(value, 128);
  if (!normalized || Number.isNaN(Date.parse(normalized))) return null;
  return normalized;
}

function storedHttpValidator(source, request) {
  if (request.method !== "GET") return null;
  const stored = source?.collection?.httpValidator;
  if (stored?.schemaVersion !== HTTP_VALIDATOR_SCHEMA_VERSION || stored.method !== "GET") return null;
  let requestUrl;
  try { requestUrl = new URL(request.url).toString(); } catch { return null; }
  if (stored.requestUrl !== requestUrl) return null;
  const etag = safeEtag(stored.etag);
  const lastModified = safeLastModified(stored.lastModified);
  return etag || lastModified ? { ...stored, etag, lastModified } : null;
}

/**
 * Attach validators only to the exact GET resource that produced them. An
 * explicit request-level conditional header always wins over Registry state.
 */
export function withConditionalGet(source, request) {
  const stored = storedHttpValidator(source, request);
  if (!stored) return { request, conditional: null };
  const headers = new Headers(request.headers || {});
  if (stored.etag && !headers.has("if-none-match")) headers.set("if-none-match", stored.etag);
  if (stored.lastModified && !headers.has("if-modified-since")) headers.set("if-modified-since", stored.lastModified);
  const conditional = headers.has("if-none-match") || headers.has("if-modified-since") ? stored : null;
  return {
    request: { ...request, headers: Object.fromEntries(headers.entries()) },
    conditional,
  };
}

function validatorCheckpoint(request, response, previous = null) {
  if (request.method !== "GET") return undefined;
  const etag = safeEtag(response.headers?.etag) || (response.status === 304 ? safeEtag(previous?.etag) : null);
  const lastModified = safeLastModified(response.headers?.["last-modified"])
    || (response.status === 304 ? safeLastModified(previous?.lastModified) : null);
  if (!etag && !lastModified) return null;
  return {
    schemaVersion: HTTP_VALIDATOR_SCHEMA_VERSION,
    method: "GET",
    requestUrl: new URL(request.url).toString(),
    finalUrl: new URL(response.finalUrl).toString(),
    etag,
    lastModified,
    contentHash: response.status === 304 ? previous?.contentHash || null : response.contentHash,
    checkedAt: response.fetchedAt,
    status: response.status,
  };
}

/** Parse Retry-After while preventing an upstream response from creating an
 * unbounded sleep. Invalid values are ignored and valid waits are capped. */
export function retryAfterDelayMs(value, now = Date.now()) {
  const normalized = safeValidatorHeader(value, 128);
  if (!normalized) return null;
  let milliseconds;
  if (/^\d+$/.test(normalized)) milliseconds = Number(normalized) * 1_000;
  else {
    const target = Date.parse(normalized);
    if (Number.isNaN(target)) return null;
    milliseconds = Math.max(0, target - Number(now));
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.floor(milliseconds));
}

function nonnegativeSafeInteger(raw, label, code, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw Object.assign(new TypeError(`${label} 必须是 0 到 ${maximum} 的安全整数`), { code });
  }
  return value;
}

function publicRecruitmentCursorFingerprint(source, endpoint) {
  const candidate = source.candidate;
  if (!OFFSET_PAGINATION_PROVIDERS.has(candidate.provider)) return null;
  const fixed = publicRecruitmentFixedQuery(candidate);
  let portalPath = candidate.portalPath || null;
  if (!portalPath && candidate.provider === "FeishuRecruitment") {
    try { portalPath = new URL(candidate.sourceRootUrl).pathname.split("/").filter(Boolean)[0] || "index"; }
    catch { portalPath = null; }
  }
  const descriptor = {
    provider: candidate.provider,
    endpoint: new URL(endpoint).toString(),
    sourceKey: source.sourceKey || candidate.sourceKey || null,
    tenant: candidate.tenant || null,
    portalPath,
    trustEpoch: {
      approvedAt: source.approvedAt || null,
      reviewedAt: source.review?.reviewedAt || source.reviewedAt || null,
    },
    method: "POST",
    portalType: fixed.portal_type,
    filters: Object.fromEntries(Object.entries(fixed).filter(([key]) => key !== "portal_type")),
    sort: "upstream_default",
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`;
}

function resolveCursor(source, requestedOffset, requestedGeneration, fingerprint) {
  const offsetPaginated = OFFSET_PAGINATION_PROVIDERS.has(source?.candidate?.provider);
  const explicitOffset = requestedOffset === undefined
    ? undefined
    : nonnegativeSafeInteger(requestedOffset, "startOffset", "INVALID_START_OFFSET", MAX_CURSOR_OFFSET);
  if (!offsetPaginated && explicitOffset !== undefined && explicitOffset !== 0) {
    throw Object.assign(new TypeError(`${source?.candidate?.provider || "该来源"} 不支持 offset 断点采集`), { code: "START_OFFSET_UNSUPPORTED" });
  }
  if (!offsetPaginated) return { startOffset: 0, generation: 0 };

  const resume = source?.collection?.resume;
  const persistedValid = resume?.schemaVersion === "huangque.collection-resume.v1"
    && resume.fingerprint === fingerprint
    && Number.isSafeInteger(Number(resume.generation))
    && Number(resume.generation) >= 0
    && Number(resume.generation) <= MAX_CURSOR_GENERATION
    && Number.isSafeInteger(Number(resume.nextOffset))
    && Number(resume.nextOffset) >= 0
    && Number(resume.nextOffset) <= MAX_CURSOR_OFFSET;
  if (resume && !persistedValid) {
    // An endpoint/filter fingerprint change invalidates the old cursor. Start
    // from the head and let Registry atomically establish a new generation.
    return { startOffset: 0, generation: 0 };
  }
  if (persistedValid) {
    const persistedOffset = Number(resume.nextOffset);
    const persistedGeneration = Number(resume.generation);
    if (explicitOffset !== undefined && explicitOffset !== persistedOffset) {
      throw Object.assign(new Error("startOffset 与持久化断点不一致"), { code: "CURSOR_OFFSET_MISMATCH" });
    }
    if (requestedGeneration !== undefined
      && nonnegativeSafeInteger(requestedGeneration, "cursorGeneration", "INVALID_CURSOR_GENERATION", MAX_CURSOR_GENERATION) !== persistedGeneration) {
      throw Object.assign(new Error("cursorGeneration 与持久化断点不一致"), { code: "CURSOR_GENERATION_MISMATCH" });
    }
    return { startOffset: persistedOffset, generation: persistedGeneration };
  }

  const generation = requestedGeneration === undefined
    ? 0
    : nonnegativeSafeInteger(requestedGeneration, "cursorGeneration", "INVALID_CURSOR_GENERATION", MAX_CURSOR_GENERATION);
  return { startOffset: explicitOffset ?? 0, generation };
}

async function fetchCollectionPage(url, { retryTransient = false, ...options }, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await safeFetch(url, options);
      const retryAfter = retryAfterDelayMs(response.headers?.["retry-after"]);
      if (retryTransient && [429, 503].includes(response.status) && retryAfter !== null && attempt < attempts) {
        if (retryAfter > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, retryAfter));
        continue;
      }
      return response;
    }
    catch (error) {
      lastError = error;
      if (!retryTransient || !TRANSIENT_COLLECTION_ERRORS.has(error?.code) || attempt === attempts) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * attempt));
    }
  }
  throw lastError;
}

function advertisedTotal(payload) {
  const values = [payload?.total, payload?.totalCount, payload?.data?.count, payload?.data?.total, payload?.data?.totalCount, payload?.result?.total, payload?.returnData?.total];
  const value = values.find((item) => Number.isFinite(Number(item)) && Number(item) >= 0);
  return value === undefined ? null : Number(value);
}

function withArtifactEvidence(error, artifacts) {
  error.artifacts = artifacts.map((artifact) => ({
    observationId: artifact.observationId,
    contentHash: artifact.contentHash,
  }));
  return error;
}

function responseSummary(response) {
  return {
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    status: response.status,
    ok: response.ok,
    contentType: response.contentType,
    bytes: response.bytes,
    contentHash: response.contentHash,
    redirectChain: response.redirectChain,
    fetchedAt: response.fetchedAt,
  };
}

export async function collectApprovedSource(registry, sourceId, {
  commit = false,
  runId = null,
  now = new Date(),
  fetchOptions = {},
  artifactStore = null,
  startOffset = undefined,
  cursorGeneration = undefined,
} = {}) {
  const snapshot = await registry.snapshot();
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
  if (source.lifecycle !== "approved" || !source.collectionEnabled) {
    throw Object.assign(new Error("只有人工批准且启用的来源才能采集"), { code: "SOURCE_NOT_APPROVED" });
  }
  const candidate = source.candidate;
  const offsetPaginated = OFFSET_PAGINATION_PROVIDERS.has(candidate.provider);
  const endpoint = source.probe?.collectionEndpoint || candidate.publicApiUrl || candidate.sourceRootUrl;
  const cursorFingerprint = publicRecruitmentCursorFingerprint(source, endpoint);
  const cursor = resolveCursor(source, startOffset, cursorGeneration, cursorFingerprint);
  const effectiveStartOffset = cursor.startOffset;
  // Offset feeds can drift when newly published jobs are inserted ahead of a
  // saved cursor. Re-read one full upstream page at the next committed segment
  // and let exact source/external-id dedupe absorb the deliberate overlap.
  const overlapRows = offsetPaginated ? PUBLIC_RECRUITMENT_PAGE_SIZE : 0;
  const robots = await fetchRobotsPolicy(endpoint, fetchOptions);
  if (!robots.allowed) {
    const code = robots.reason === "robots_disallowed"
      ? "ROBOTS_DISALLOWED"
      : [401, 403].includes(robots.status) ? "ROBOTS_ACCESS_RESTRICTED" : "ROBOTS_UNAVAILABLE";
    const message = code === "ROBOTS_DISALLOWED"
      ? "robots.txt 明确禁止访问，采集停止"
      : code === "ROBOTS_ACCESS_RESTRICTED"
        ? `robots.txt 返回 HTTP ${robots.status}，无法确认采集许可，来源自动停用等待复核`
        : "robots.txt 暂时无法核验，采集按安全策略停止并留待重试";
    throw Object.assign(new Error(message), { code, robots });
  }
  const observedAt = new Date(now).toISOString();
  const maxPages = ["ByteDance", "FeishuRecruitment"].includes(candidate.provider) ? 50 : 20;
  const maxCollectionRows = 5_000;
  const maxCollectionBytes = 24_000_000;
  const normalizedPages = [];
  const responses = [];
  const artifacts = [];
  const rawPageSignatures = new Set();
  let firstGetRequest = null;
  let firstGetValidatorCheckpoint = undefined;
  let rowsObserved = 0;
  let headRefreshRows = 0;
  let tailRowsObserved = 0;
  let headRefreshSignature = null;
  let cursorAdvanceBlocked = false;
  let observedAdvertisedTotal = null;
  let paginationComplete = false;
  let cycleEndReached = false;
  let stopReason = "single_page";
  let publicSession = await createPublicRecruitmentSession(candidate, endpoint, { fetchOptions, robots });
  let publicSessionRefreshes = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const isHeadRefresh = offsetPaginated && effectiveStartOffset > 0 && page === 1;
    const requestOffset = isHeadRefresh ? 0 : effectiveStartOffset + tailRowsObserved;
    let request = collectionPage(candidate, endpoint, page, publicSession.headers, requestOffset);
    let conditional = null;
    if (page === 1 && request.method === "GET") {
      const prepared = withConditionalGet(source, request);
      request = prepared.request;
      conditional = prepared.conditional;
      firstGetRequest = request;
    }
    let response = await fetchCollectionPage(request.url, {
      ...fetchOptions,
      method: request.method,
      headers: request.headers,
      body: request.body,
      retryTransient: ["GET", "HEAD"].includes(request.method)
        || ["BeijingPublicEmployment", "ByteDance", "FeishuRecruitment"].includes(candidate.provider),
      maxBytes: 8_000_000,
      redirectGuard: ({ to }) => robotsAllowsRules(robots.rules || [], to),
    });
    // The public frontend refreshes its anonymous CSRF session when it expires.
    // Retry that specific read-only request once; never attempt signatures,
    // CAPTCHA solving, login cookies, or other access-control workarounds.
    if (response.status === 405 && response.headers?.["x-risk-tag"] !== "2" && publicSession.evidence && publicSessionRefreshes === 0) {
      publicSession = await createPublicRecruitmentSession(candidate, endpoint, { fetchOptions, robots });
      publicSessionRefreshes += 1;
      request = collectionPage(candidate, endpoint, page, publicSession.headers, requestOffset);
      response = await fetchCollectionPage(request.url, {
        ...fetchOptions,
        method: request.method,
        headers: request.headers,
        body: request.body,
        retryTransient: true,
        maxBytes: 8_000_000,
        redirectGuard: ({ to }) => robotsAllowsRules(robots.rules || [], to),
      });
    }
    let artifact = null;
    if (artifactStore) {
      try {
        artifact = await artifactStore.put(response, { kind: "collection_response", sourceId, runId, page });
        artifacts.push(artifact);
      } catch (error) {
        throw Object.assign(new Error(`第 ${page} 页原始响应工件写入失败：${error.message}`), { code: "ARTIFACT_STORE_FAILED", cause: error });
      }
    }
    if (page === 1 && request.method === "GET") {
      if (response.status === 304 && !conditional) {
        throw withArtifactEvidence(Object.assign(new Error("来源返回 304，但本次请求没有可验证的持久条件请求头"), { code: "UNEXPECTED_NOT_MODIFIED", page }), artifacts);
      }
      firstGetValidatorCheckpoint = validatorCheckpoint(request, response, conditional);
      if (response.status === 304) {
        const result = await registry.storeJobs(sourceId, [], {
          commit,
          runId,
          allowMissingAdvance: false,
          markMissingNeedsReview: false,
          notModified: true,
          httpValidatorCheckpoint: firstGetValidatorCheckpoint,
          expectedSourceRevision: source.revision,
        });
        return {
          schemaVersion: "huangque.collection.v1",
          runId,
          sourceId,
          sourceRevision: source.revision,
          commit,
          endpoint,
          fetchedAt: response.fetchedAt,
          http: {
            status: response.status,
            finalUrl: response.finalUrl,
            contentType: response.contentType,
            bytes: response.bytes,
            contentHash: conditional.contentHash || response.contentHash,
            redirectChain: response.redirectChain,
            pages: 1,
            notModified: true,
          },
          robots,
          session: publicSession.evidence ? { ...publicSession.evidence, refreshes: publicSessionRefreshes } : null,
          artifact,
          artifacts,
          pagination: {
            complete: false,
            pages: 1,
            maxPages,
            stopReason: "http_304_not_modified",
            advertisedTotal: null,
            startOffset: effectiveStartOffset,
            observedEndOffset: effectiveStartOffset,
            nextOffset: effectiveStartOffset,
            overlapRows,
            cycleEndReached: false,
            headRefreshRows: 0,
            tailRowsObserved: 0,
            cursorFingerprint,
            cursorGeneration: cursor.generation,
          },
          parser: "http_304_not_modified",
          parserStats: { observedRows: 0, headRefreshRows: 0, tailRowsObserved: 0, beijingRows: 0 },
          dedupe: { stats: { input: 0, unique: 0 }, exactDuplicates: [], duplicateCandidates: [], identityConflicts: [] },
          storage: {
            received: 0,
            new: 0,
            updated: 0,
            unchanged: result.unchanged || 0,
            missing: 0,
            missingAdvanceSuppressed: true,
            missingReviewOnly: false,
            missingThreshold: 2,
            notModified: true,
          },
          validators: firstGetValidatorCheckpoint,
          jobs: [],
        };
      }
    }
    const nextBytes = responses.reduce((sum, item) => sum + item.bytes, 0) + response.bytes;
    if (nextBytes > maxCollectionBytes) {
      // Keep the already parsed pages as an explicitly incomplete bounded
      // observation. Large public boards (ByteDance currently advertises far
      // more rows than one safe run should retain) must not lose every earlier
      // page merely because the next page crosses the cumulative byte budget.
      // Incomplete observations never advance authoritative missing counters.
      stopReason = "byte_budget_reached";
      paginationComplete = false;
      break;
    }
    if (!response.ok) throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页返回 HTTP ${response.status}`), { code: "COLLECTION_HTTP_ERROR", status: response.status, page }), artifacts);
    let normalized;
    try { normalized = normalizeAdapterPayload(source, response, observedAt); }
    catch (error) { throw withArtifactEvidence(error, artifacts); }
    if (normalized.inspection.format === "invalid_json") {
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页 JSON 无法解析：${normalized.inspection.error}`), { code: "COLLECTION_SCHEMA_DRIFT", page }), artifacts);
    }
    if (["Lever", "Greenhouse", "Ashby", "ByteDance", "FeishuRecruitment", "NCSS", "BeijingPublicEmployment"].includes(candidate.provider)
      && normalized.inspection.format === "json" && normalized.inspection.schemaRecognized !== true) {
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页不再符合 ${candidate.provider} 的已知公开结构`), { code: "COLLECTION_SCHEMA_DRIFT", page }), artifacts);
    }
    if (["ByteDance", "FeishuRecruitment"].includes(candidate.provider) && Number(normalized.inspection.payload?.code) !== 0) {
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页返回业务错误 ${normalized.inspection.payload?.code ?? "unknown"}`), { code: "COLLECTION_UPSTREAM_ERROR", page }), artifacts);
    }
    if (normalized.inspection.rowLimitExceeded || normalized.inspection.structuralLimitExceeded) {
      const limit = normalized.inspection.maximumRows || normalized.inspection.maximumStructuralTokens;
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页结构规模超过安全上限 ${limit}`), { code: "COLLECTION_ROW_LIMIT_EXCEEDED", page }), artifacts);
    }
    if (Number(normalized.inspection.rejectedCrossOriginJobs || 0) > 0) {
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页包含 ${normalized.inspection.rejectedCrossOriginJobs} 条越过已批准来源边界的岗位 URL；本次数据未提交`), {
        code: "UNSAFE_JOB_ORIGIN",
        page,
        rejectedCrossOriginJobs: normalized.inspection.rejectedCrossOriginJobs,
      }), artifacts);
    }
    if (rowsObserved + normalized.inspection.totalRows > maxCollectionRows) {
      throw withArtifactEvidence(Object.assign(new Error(`单次来源采集岗位行累计超过 ${maxCollectionRows} 条安全上限`), { code: "COLLECTION_TOTAL_LIMIT_EXCEEDED", page }), artifacts);
    }
    const advertised = advertisedTotal(normalized.inspection.payload);
    if (advertised !== null) observedAdvertisedTotal = Math.max(Number(observedAdvertisedTotal || 0), advertised);
    const signature = createHash("sha256").update(JSON.stringify(normalized.inspection.rows)).digest("hex");
    if (page > 1 && normalized.inspection.totalRows > 0 && rawPageSignatures.has(signature)) {
      const matchesHeadRefresh = Boolean(headRefreshSignature && signature === headRefreshSignature);
      stopReason = matchesHeadRefresh ? "offset_not_honored" : "repeated_page_guard";
      if (matchesHeadRefresh) cursorAdvanceBlocked = true;
      paginationComplete = false;
      break;
    }
    rawPageSignatures.add(signature);
    if (isHeadRefresh) headRefreshSignature = signature;
    normalizedPages.push({
      ...normalized,
      inspection: { ...normalized.inspection, payload: null, rows: [] },
    });
    responses.push(responseSummary(response));
    rowsObserved += normalized.inspection.totalRows;
    if (isHeadRefresh) headRefreshRows += normalized.inspection.totalRows;
    else if (offsetPaginated) tailRowsObserved += normalized.inspection.totalRows;
    if (artifact) {
      for (const job of normalized.jobs) {
        job.evidence = [...(job.evidence || []), {
          kind: "collection_artifact",
          sourceId,
          runId,
          page,
          observationId: artifact.observationId,
          contentHash: artifact.contentHash,
          fetchedAt: response.fetchedAt,
        }];
      }
    }
    if (!request.paginated) {
      paginationComplete = true;
      cycleEndReached = true;
      stopReason = "single_page";
      break;
    }
    const total = observedAdvertisedTotal;
    if (isHeadRefresh) {
      // The refresh keeps newly inserted head jobs fresh but does not advance
      // the tail cursor. If the persisted cursor is already at/past the newly
      // advertised end, rotate safely to zero without issuing a redundant tail
      // request.
      if (total !== null && effectiveStartOffset >= total) {
        cycleEndReached = true;
        paginationComplete = false;
        stopReason = "cursor_beyond_advertised_total";
        break;
      }
      if (!fetchOptions.fetchImpl || fetchOptions.fetchImpl === globalThis.fetch) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
      continue;
    }
    const observedEndOffset = effectiveStartOffset + tailRowsObserved;
    const advertisedTotalReached = total !== null && observedEndOffset >= total;
    const shortPageWithoutAdvertisedRemainder = total === null && normalized.inspection.totalRows < request.pageSize;
    if (normalized.inspection.totalRows === 0 || advertisedTotalReached || shortPageWithoutAdvertisedRemainder) {
      const advertisedGap = normalized.inspection.totalRows === 0 && total !== null && observedEndOffset < total;
      cycleEndReached = !advertisedGap;
      // Only a complete traversal that began at zero is authoritative for
      // missing-job advancement. A tail segment closes the rotation cycle but
      // never claims to have observed the whole board in this invocation.
      paginationComplete = cycleEndReached && effectiveStartOffset === 0;
      stopReason = advertisedGap ? "advertised_total_gap" : normalized.inspection.totalRows === 0 ? "empty_terminal_page" : advertisedTotalReached ? "advertised_total_reached" : "short_terminal_page";
      break;
    }
    if (page === maxPages) stopReason = "page_limit_reached";
    if (["ByteDance", "FeishuRecruitment"].includes(candidate.provider)
      && (!fetchOptions.fetchImpl || fetchOptions.fetchImpl === globalThis.fetch)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  if (!responses.length) throw Object.assign(new Error("采集器没有得到可解析页面"), { code: "COLLECTION_NO_PAGE" });
  const normalized = normalizedPages[0];
  const deduped = dedupeJobs(normalizedPages.flatMap((page) => page.jobs));
  if (deduped.identityConflicts.length > 0) {
    throw withArtifactEvidence(Object.assign(new Error(`来源返回 ${deduped.identityConflicts.length} 组互相冲突的岗位 externalId；本次数据未提交，需复核来源结构`), {
      code: "JOB_IDENTITY_CONFLICT",
      identityConflicts: deduped.identityConflicts,
    }), artifacts);
  }
  // An empty, schema-recognized ATS feed is explicit evidence that the board
  // currently has no jobs; use a stricter three-observation threshold. HTML,
  // XML and other non-authoritative lists never auto-close jobs, but a job that
  // disappears from a successful complete fetch must stop being advertised as
  // confirmed active until it is observed again or its detail is revalidated.
  const authoritativeProviders = new Set(["Lever", "Greenhouse", "Ashby", "ByteDance", "FeishuRecruitment", "NCSS", "BeijingPublicEmployment"]);
  const authoritativeComplete = paginationComplete
    && (!offsetPaginated || effectiveStartOffset === 0)
    && authoritativeProviders.has(candidate.provider)
    && deduped.identityConflicts.length === 0
    && normalizedPages.every((page) => page.inspection.format === "json"
      && page.inspection.schemaRecognized === true
      && Number(page.inspection.rejectedCrossOriginJobs || 0) === 0);
  const completeKnownEmpty = authoritativeComplete && deduped.jobs.length === 0;
  const allowMissingAdvance = authoritativeComplete && (deduped.jobs.length > 0 || completeKnownEmpty);
  const markMissingNeedsReview = paginationComplete && !allowMissingAdvance;
  const missingThreshold = completeKnownEmpty ? 3 : 2;
  const observedEndOffset = offsetPaginated ? effectiveStartOffset + tailRowsObserved : 0;
  const nextOffset = offsetPaginated
    ? cycleEndReached
      ? 0
      : cursorAdvanceBlocked
        ? effectiveStartOffset
        : Math.max(effectiveStartOffset, observedEndOffset - overlapRows)
    : 0;
  const collectionCheckpoint = offsetPaginated ? {
    schemaVersion: "huangque.collection-resume.v1",
    fingerprint: cursorFingerprint,
    generation: cursor.generation,
    startOffset: effectiveStartOffset,
    nextOffset,
    cycleEndReached,
    headRefreshRows,
    tailRowsObserved,
  } : null;
  let result;
  try {
    result = await registry.storeJobs(sourceId, deduped.jobs, {
      commit,
      runId,
      allowMissingAdvance,
      markMissingNeedsReview,
      missingThreshold,
      collectionCheckpoint,
      httpValidatorCheckpoint: firstGetRequest ? firstGetValidatorCheckpoint : undefined,
      expectedSourceRevision: source.revision,
    });
  } catch (error) {
    throw withArtifactEvidence(error, artifacts);
  }
  return {
    schemaVersion: "huangque.collection.v1",
    runId,
    sourceId,
    sourceRevision: source.revision,
    commit,
    endpoint,
    fetchedAt: responses.at(-1).fetchedAt,
    http: {
      status: responses[0].status,
      finalUrl: responses.at(-1).finalUrl,
      contentType: responses[0].contentType,
      bytes: responses.reduce((sum, response) => sum + response.bytes, 0),
      contentHash: responses.at(-1).contentHash,
      redirectChain: responses.flatMap((response) => response.redirectChain),
      pages: responses.length,
    },
    robots,
    session: publicSession.evidence ? { ...publicSession.evidence, refreshes: publicSessionRefreshes } : null,
    artifact: artifacts[0] || null,
    artifacts,
    pagination: {
      complete: paginationComplete,
      pages: responses.length,
      maxPages,
      stopReason,
      advertisedTotal: observedAdvertisedTotal,
      startOffset: effectiveStartOffset,
      observedEndOffset,
      nextOffset,
      overlapRows,
      cycleEndReached,
      headRefreshRows,
      tailRowsObserved,
      cursorFingerprint,
      cursorGeneration: cursor.generation,
    },
    parser: normalized.strategy,
    parserStats: {
      observedRows: rowsObserved,
      headRefreshRows,
      tailRowsObserved,
      beijingRows: normalizedPages.reduce((sum, page) => sum + page.inspection.beijingRows, 0),
    },
    dedupe: {
      stats: deduped.stats,
      exactDuplicates: deduped.exactDuplicates,
      duplicateCandidates: deduped.duplicateCandidates,
      identityConflicts: deduped.identityConflicts,
    },
    storage: {
      received: result.received,
      new: result.new,
      updated: result.updated,
      unchanged: result.unchanged || 0,
      missing: result.missing || 0,
      missingAdvanceSuppressed: !allowMissingAdvance,
      missingReviewOnly: markMissingNeedsReview,
      missingThreshold,
      notModified: false,
    },
    validators: firstGetRequest ? firstGetValidatorCheckpoint : null,
    jobs: deduped.jobs,
  };
}
