import { createHash } from "node:crypto";
import { dedupeJobs, normalizeAdapterPayload } from "./adapters.mjs";
import { fetchRobotsPolicy, robotsAllowsRules, safeFetch } from "./http.mjs";

function collectionPage(candidate, endpoint, page) {
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
  return { url: endpoint, paginated: false, pageSize: null, method: "GET" };
}

function advertisedTotal(payload) {
  const values = [payload?.total, payload?.totalCount, payload?.data?.total, payload?.data?.totalCount, payload?.result?.total, payload?.returnData?.total];
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
} = {}) {
  const snapshot = await registry.snapshot();
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
  if (source.lifecycle !== "approved" || !source.collectionEnabled) {
    throw Object.assign(new Error("只有人工批准且启用的来源才能采集"), { code: "SOURCE_NOT_APPROVED" });
  }
  const candidate = source.candidate;
  const endpoint = source.probe?.collectionEndpoint || candidate.publicApiUrl || candidate.sourceRootUrl;
  const robots = await fetchRobotsPolicy(endpoint, fetchOptions);
  if (!robots.allowed) throw Object.assign(new Error("robots.txt 已禁止访问，采集停止"), { code: "ROBOTS_DISALLOWED" });
  const observedAt = new Date(now).toISOString();
  const maxPages = 20;
  const maxCollectionRows = 5_000;
  const maxCollectionBytes = 24_000_000;
  const normalizedPages = [];
  const responses = [];
  const artifacts = [];
  const rawPageSignatures = new Set();
  let rowsObserved = 0;
  let paginationComplete = false;
  let stopReason = "single_page";
  for (let page = 1; page <= maxPages; page += 1) {
    const request = collectionPage(candidate, endpoint, page);
    const response = await safeFetch(request.url, {
      ...fetchOptions,
      method: request.method,
      headers: request.headers,
      body: request.body,
      maxBytes: 8_000_000,
      redirectGuard: ({ to }) => robotsAllowsRules(robots.rules || [], to),
    });
    let artifact = null;
    if (artifactStore) {
      try {
        artifact = await artifactStore.put(response, { kind: "collection_response", sourceId, runId, page });
        artifacts.push(artifact);
      } catch (error) {
        throw Object.assign(new Error(`第 ${page} 页原始响应工件写入失败：${error.message}`), { code: "ARTIFACT_STORE_FAILED", cause: error });
      }
    }
    const nextBytes = responses.reduce((sum, item) => sum + item.bytes, 0) + response.bytes;
    if (nextBytes > maxCollectionBytes) {
      throw withArtifactEvidence(Object.assign(new Error(`单次来源采集响应累计超过 ${maxCollectionBytes} 字节安全上限`), { code: "COLLECTION_TOTAL_LIMIT_EXCEEDED", page }), artifacts);
    }
    if (!response.ok) throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页返回 HTTP ${response.status}`), { code: "COLLECTION_HTTP_ERROR", status: response.status, page }), artifacts);
    let normalized;
    try { normalized = normalizeAdapterPayload(source, response, observedAt); }
    catch (error) { throw withArtifactEvidence(error, artifacts); }
    if (normalized.inspection.format === "invalid_json") {
      throw withArtifactEvidence(Object.assign(new Error(`采集第 ${page} 页 JSON 无法解析：${normalized.inspection.error}`), { code: "COLLECTION_SCHEMA_DRIFT", page }), artifacts);
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
    const signature = createHash("sha256").update(JSON.stringify(normalized.inspection.rows)).digest("hex");
    if (page > 1 && rawPageSignatures.has(signature)) {
      stopReason = "repeated_page_guard";
      paginationComplete = normalized.inspection.totalRows < Number(request.pageSize || 0);
      break;
    }
    rawPageSignatures.add(signature);
    normalizedPages.push({
      ...normalized,
      inspection: { ...normalized.inspection, payload: null, rows: [] },
    });
    responses.push(responseSummary(response));
    rowsObserved += normalized.inspection.totalRows;
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
      stopReason = "single_page";
      break;
    }
    const total = advertised;
    if (normalized.inspection.totalRows === 0 || normalized.inspection.totalRows < request.pageSize || total !== null && rowsObserved >= total) {
      paginationComplete = true;
      stopReason = normalized.inspection.totalRows === 0 ? "empty_terminal_page" : total !== null && rowsObserved >= total ? "advertised_total_reached" : "short_terminal_page";
      break;
    }
    if (page === maxPages) stopReason = "page_limit_reached";
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
  const authoritativeProviders = new Set(["Lever", "Greenhouse", "Ashby", "NCSS", "BeijingPublicEmployment"]);
  const authoritativeComplete = paginationComplete
    && authoritativeProviders.has(candidate.provider)
    && deduped.identityConflicts.length === 0
    && normalizedPages.every((page) => page.inspection.format === "json"
      && page.inspection.schemaRecognized === true
      && Number(page.inspection.rejectedCrossOriginJobs || 0) === 0);
  const completeKnownEmpty = authoritativeComplete && deduped.jobs.length === 0;
  const allowMissingAdvance = authoritativeComplete && (deduped.jobs.length > 0 || completeKnownEmpty);
  const markMissingNeedsReview = paginationComplete && !allowMissingAdvance;
  const missingThreshold = completeKnownEmpty ? 3 : 2;
  let result;
  try {
    result = await registry.storeJobs(sourceId, deduped.jobs, {
      commit,
      runId,
      allowMissingAdvance,
      markMissingNeedsReview,
      missingThreshold,
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
    artifact: artifacts[0] || null,
    artifacts,
    pagination: { complete: paginationComplete, pages: responses.length, maxPages, stopReason },
    parser: normalized.strategy,
    parserStats: {
      observedRows: rowsObserved,
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
    },
    jobs: deduped.jobs,
  };
}
