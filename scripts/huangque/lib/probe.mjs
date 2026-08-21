import { createHash } from "node:crypto";
import { normalizeAdapterPayload, plainText } from "./adapters.mjs";
import { fetchRobotsPolicy, isLocalControlError, robotsAllowsRules, safeFetch } from "./http.mjs";
import { canonicalizeUrl, sourceOwnsJobUrl } from "./source-discovery.mjs";
import { createPublicRecruitmentSession } from "./public-recruitment-session.mjs";

const LOGIN_OR_CHALLENGE = /login required|sign[ -]?in required|please log in|access denied|captcha|cloudflare challenge|验证码|请先登录|登录后查看|仅限登录|访问受限|付费墙/i;
const RECRUITMENT_LANGUAGE = /招聘|岗位|职位|招考|报名|录用|就业|人社|人力资源|人才|career|careers|job|jobs|hiring|position|opening|talent/i;
const ALLOWED_CONTENT = /(?:application\/(?:json|ld\+json|xml)|text\/(?:html|plain|xml)|\+json|\+xml)/i;

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] || null;
}

export function extractPageSignals(html, baseUrl) {
  const edges = [];
  const jobLinks = [];
  const seen = new Set();
  const tags = [
    ...(String(html || "").match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []),
    ...(String(html || "").match(/<link\b[^>]*>/gi) || []),
  ];
  for (const tag of tags) {
    const href = extractAttribute(tag, "href");
    if (!href) continue;
    let url;
    try { url = canonicalizeUrl(new URL(href, baseUrl).toString()); } catch { continue; }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const rel = (extractAttribute(tag, "rel") || "").toLowerCase();
    const type = (extractAttribute(tag, "type") || "").toLowerCase();
    const text = plainText(tag);
    const machineIndex = /rss|atom/.test(type) || /alternate/.test(rel) && /feed/.test(url) || /sitemap/i.test(url);
    if (/rss|atom/.test(type) || /alternate/.test(rel) && /feed/.test(url)) {
      edges.push({ type: "feed", to: url, evidence: { rel, contentType: type } });
    } else if (/sitemap/i.test(url)) {
      edges.push({ type: "sitemap", to: url, evidence: { rel } });
    }
    if (!machineIndex && RECRUITMENT_LANGUAGE.test(`${url} ${text}`) && !/login|signin/i.test(url)) jobLinks.push({ url, text });
  }
  const title = plainText((String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return {
    title,
    edges,
    jobLinks: jobLinks.slice(0, 50),
    recruitmentLanguage: RECRUITMENT_LANGUAGE.test(`${title} ${plainText(html).slice(0, 60_000)}`),
    loginOrChallenge: LOGIN_OR_CHALLENGE.test(`${title} ${plainText(html).slice(0, 60_000)}`),
  };
}

function publicEndpoint(candidate) {
  return candidate.publicApiUrl || candidate.sourceRootUrl || candidate.entryUrl;
}

function requestOptions(candidate) {
  if (["ByteDance", "FeishuRecruitment"].includes(candidate.provider) && /\/api\/v1\/search\/job\/posts/i.test(candidate.publicApiUrl || "")) {
    const feishu = candidate.provider === "FeishuRecruitment";
    return {
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "portal-channel": feishu ? "saas-career" : "office",
        "portal-platform": "pc",
      },
      body: JSON.stringify({
        keyword: "",
        limit: 20,
        offset: 0,
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
      }),
    };
  }
  if (candidate.provider === "BeijingPublicEmployment" && /\/zyjp\/getTblb/i.test(candidate.publicApiUrl || "")) {
    return {
      method: "POST",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ ssqs: [], gwlms: [], sgwlms: [], ssnr: "", tjid: ["01"], pageSize: 50, pageNum: 1, mkId: 70 }),
    };
  }
  return { method: "GET" };
}

function providerStrategy(candidate, inspection, pageSignals) {
  if (candidate.provider === "Lever") return "lever_public_api";
  if (candidate.provider === "Greenhouse") return "greenhouse_public_api";
  if (candidate.provider === "Ashby") return "ashby_public_api";
  if (candidate.provider === "ByteDance") return "bytedance_public_search_api";
  if (candidate.provider === "FeishuRecruitment") return "feishu_recruitment_public_search_api";
  if (candidate.provider === "NCSS") return "ncss_public_json";
  if (candidate.provider === "BeijingPublicEmployment") return "beijing_public_employment_json";
  if (inspection.format === "xml" && inspection.totalRows > 0) return "xml_feed_or_sitemap";
  if (inspection.format === "html" && inspection.totalRows > 0) return "jobposting_jsonld";
  if (pageSignals.jobLinks.length > 0) return "listing_html";
  return "unsupported";
}

function likelyCollectionPage(value) {
  try {
    const path = new URL(value).pathname;
    if (/\/(?:jobs?|positions?)\/[^/]+(?:\/detail)?\/?$/i.test(path)
      && !/\/(?:jobs?|positions?)\/?$/i.test(path)) return false;
    return /\/(?:jobs?|careers?|career|recruit(?:ment)?|positions?|experienced|campus)(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function normalizeProbeResponse(candidate, response, probedAt) {
  return normalizeAdapterPayload({
    id: candidate.id,
    sourceKey: candidate.sourceKey || candidate.id,
    name: candidate.name || candidate.tenant || candidate.id,
    candidate,
    probe: null,
  }, response, probedAt);
}

export async function probeCandidate(candidate, {
  now = new Date(),
  fetchOptions = {},
} = {}) {
  if (!candidate?.id || !candidate?.sourceRootUrl) throw new TypeError("probeCandidate 需要完整候选来源");
  const probedAt = new Date(now).toISOString();
  const targetUrl = publicEndpoint(candidate);
  const robots = await fetchRobotsPolicy(targetUrl, fetchOptions);
  if (!robots.allowed) {
    const verificationState = robots.reason === "robots_disallowed" ? "blocked_robots"
      : [401, 403].includes(robots.status) ? "access_restricted" : "probe_failed";
    const message = robots.reason === "robots_disallowed" ? "robots.txt 明确禁止黄雀访问该路径"
      : [401, 403].includes(robots.status) ? `robots.txt 返回 HTTP ${robots.status}，无法确认公开访问权限`
        : "robots.txt 暂时无法核验；本次安全停止，24 小时退避后可自动重试";
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState,
      collectable: false,
      strategy: "none",
      robots,
      evidence: [{ kind: "robots", ...robots }],
      errors: [{ code: verificationState === "probe_failed" ? "ROBOTS_UNAVAILABLE" : verificationState === "access_restricted" ? "ROBOTS_ACCESS_RESTRICTED" : "ROBOTS_DISALLOWED", message }],
      edges: [],
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  let response;
  let publicSession = { headers: {}, evidence: null };
  try {
    publicSession = await createPublicRecruitmentSession(candidate, targetUrl, { fetchOptions, robots });
    const request = requestOptions(candidate);
    response = await safeFetch(targetUrl, {
      ...fetchOptions,
      ...request,
      headers: {
        ...(fetchOptions.headers || {}),
        ...(request.headers || {}),
        ...publicSession.headers,
      },
      redirectGuard: ({ to }) => robotsAllowsRules(robots.rules || [], to),
    });
  } catch (error) {
    if (isLocalControlError(error)) throw error;
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState: "probe_failed",
      collectable: false,
      strategy: "none",
      robots,
      evidence: [{ kind: "robots", ...robots }],
      errors: [{ code: error.code || "FETCH_FAILED", message: error.message }],
      edges: [],
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  const httpObservation = {
    kind: "http_observation",
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: response.contentType,
    bytes: response.bytes,
    contentHash: response.contentHash,
    redirectChain: response.redirectChain,
    fetchedAt: response.fetchedAt,
  };
  const evidence = [
    { kind: "robots", ...robots },
    ...(publicSession.evidence ? [publicSession.evidence] : []),
    httpObservation,
  ];
  const edges = [];
  if (candidate.publicApiUrl) edges.push({ type: "collection_endpoint", to: candidate.publicApiUrl, evidence: { provider: candidate.provider, endpointType: "api" } });
  for (const redirect of response.redirectChain) edges.push({ type: "redirects_to", to: redirect.to, evidence: redirect });

  if (!response.ok) {
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState: response.status === 401 || response.status === 403 ? "access_restricted" : "probe_failed",
      collectable: false,
      strategy: "none",
      robots,
      http: httpObservation,
      evidence,
      errors: [`端点返回 HTTP ${response.status}`],
      edges,
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }
  if (response.contentType && !ALLOWED_CONTENT.test(response.contentType)) {
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState: "unsupported_content_type",
      collectable: false,
      strategy: "none",
      robots,
      http: httpObservation,
      evidence,
      errors: [`不采集内容类型：${response.contentType}`],
      edges,
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  let pageSignals = extractPageSignals(response.body, response.finalUrl);
  if (pageSignals.loginOrChallenge) {
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState: "access_restricted",
      collectable: false,
      strategy: "none",
      robots,
      http: httpObservation,
      evidence,
      errors: ["页面正文显示需要登录、验证码或访问受限"],
      edges,
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  const discoveredPageEdges = [...pageSignals.edges];
  const clueLimit = candidate.sourceType === "official_source_directory" ? 25
    : candidate.authority === "official_employer" ? 8 : 0;
  const sourceClues = clueLimit > 0
    ? pageSignals.jobLinks.filter((link) => {
      try { return new URL(link.url).origin !== new URL(candidate.sourceRootUrl).origin; }
      catch { return false; }
    }).slice(0, clueLimit).map((link) => ({
      url: link.url,
      title: link.text || new URL(link.url).hostname,
      parentSourceId: candidate.id,
      parentUrl: response.finalUrl,
      evidenceKind: candidate.sourceType === "official_source_directory" ? "directory_link" : "official_employer_handoff",
    }))
    : [];
  let normalized = normalizeProbeResponse(candidate, response, probedAt);
  let inspection = normalized.inspection;
  let collectionEndpoint = targetUrl;
  if (normalized.jobs.length === 0) {
    const alternativeUrls = [...new Set([
      ...(robots.sitemaps || []),
      ...pageSignals.edges.filter((edge) => edge.type === "feed" || edge.type === "sitemap").map((edge) => edge.to),
      ...(inspection.nestedSitemaps || []),
      ...pageSignals.jobLinks.map((link) => link.url).filter(likelyCollectionPage),
    ])].filter((url) => sourceOwnsJobUrl({ candidate }, url, { responseUrl: response.finalUrl })).slice(0, 8);
    for (let alternativeIndex = 0; alternativeIndex < alternativeUrls.length && alternativeIndex < 8; alternativeIndex += 1) {
      const alternativeUrl = alternativeUrls[alternativeIndex];
      try {
        const alternativeRobots = await fetchRobotsPolicy(alternativeUrl, fetchOptions);
        if (!alternativeRobots.allowed) continue;
        const alternativeResponse = await safeFetch(alternativeUrl, {
          ...fetchOptions,
          redirectGuard: ({ to }) => robotsAllowsRules(alternativeRobots.rules || [], to),
        });
        if (!alternativeResponse.ok || alternativeResponse.contentType && !ALLOWED_CONTENT.test(alternativeResponse.contentType)) continue;
        const alternativeSignals = extractPageSignals(alternativeResponse.body, alternativeResponse.finalUrl);
        if (alternativeSignals.loginOrChallenge) continue;
        const alternativeNormalized = normalizeProbeResponse(candidate, alternativeResponse, probedAt);
        const alternativeInspection = alternativeNormalized.inspection;
        if (alternativeNormalized.jobs.length === 0) {
          const nested = (alternativeInspection.nestedSitemaps || [])
            .filter((url) => !alternativeUrls.includes(url))
            .filter((url) => sourceOwnsJobUrl({ candidate }, url, { responseUrl: alternativeResponse.finalUrl }));
          alternativeUrls.push(...nested.slice(0, Math.max(0, 8 - alternativeUrls.length)));
          if (nested.length) {
            evidence.push({
              kind: "sitemap_index_observation",
              url: alternativeResponse.finalUrl,
              childSitemaps: nested.slice(0, 8),
              contentHash: alternativeResponse.contentHash,
            });
            discoveredPageEdges.push(...nested.slice(0, 8).map((url) => ({ type: "sitemap", to: url, evidence: { parent: alternativeResponse.finalUrl } })));
          }
          continue;
        }
        evidence.push({
          kind: "discovered_collection_endpoint",
          url: alternativeResponse.finalUrl,
          status: alternativeResponse.status,
          contentType: alternativeResponse.contentType,
          bytes: alternativeResponse.bytes,
          contentHash: alternativeResponse.contentHash,
          robots: alternativeRobots,
        });
        discoveredPageEdges.push(...alternativeSignals.edges);
        edges.push({ type: "collection_endpoint", to: alternativeResponse.finalUrl, evidence: { endpointType: alternativeInspection.format } });
        response = alternativeResponse;
        pageSignals = alternativeSignals;
        normalized = alternativeNormalized;
        inspection = alternativeInspection;
        collectionEndpoint = alternativeResponse.finalUrl;
        break;
      } catch (error) {
        if (isLocalControlError(error)) throw error;
        evidence.push({ kind: "collection_endpoint_failed", url: alternativeUrl, error: error.message });
      }
    }
  }
  const strategy = providerStrategy(candidate, inspection, pageSignals);
  edges.push(...discoveredPageEdges);
  for (const job of normalized.jobs.slice(0, 12)) edges.push({ type: "lists_job", to: job.applyUrl, evidence: { title: job.title } });
  const knownAdapter = strategy !== "unsupported";
  const isApi = Boolean(candidate.publicApiUrl);
  const hasRows = normalized.jobs.length > 0;
  const hasChinaRows = normalized.jobs.length > 0;
  const htmlListing = pageSignals.recruitmentLanguage && normalized.jobs.length > 0;
  const chinaListingLinks = normalized.jobs.length > 0;
  const authoritativeChinaScope = /^official_/.test(String(candidate.authority || ""))
    && Array.isArray(candidate.regions) && candidate.regions.length > 0;
  const credibleResponse = isApi ? hasRows : hasRows || htmlListing;
  const scopeVerified = hasChinaRows || chinaListingLinks
    || (htmlListing && authoritativeChinaScope);
  const unsafeJobOrigins = Number(inspection.rejectedCrossOriginJobs || 0);
  const publicSearchBusinessError = ["ByteDance", "FeishuRecruitment"].includes(candidate.provider)
    && Number(inspection.payload?.code) !== 0;
  const verificationState = publicSearchBusinessError ? "upstream_error"
    : unsafeJobOrigins > 0 ? "unsafe_job_origin"
    : inspection.rowLimitExceeded ? "payload_limit_exceeded"
      : knownAdapter && credibleResponse && scopeVerified ? "verified"
    : credibleResponse && !knownAdapter ? "adapter_unavailable"
      : credibleResponse && !scopeVerified ? "scope_not_verified"
        : "no_jobs_observed";
  const rawSamples = normalized.jobs.slice(0, 5).map((job) => ({
    id: job.externalId || job.id,
    title: job.title,
    location: job.location,
    url: job.applyUrl,
  }));
  const sampleJobs = rawSamples;
  evidence.push({
    kind: "parser_observation",
    strategy,
    collectionEndpoint,
    format: inspection.format,
    totalRows: inspection.totalRows,
    trustedJobs: normalized.jobs.length,
    rejectedCrossOriginJobs: unsafeJobOrigins,
    chinaRows: inspection.chinaRows,
    beijingRows: inspection.beijingRows,
    listingLinks: normalized.jobs.length,
    title: pageSignals.title,
  });
  const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return {
    schemaVersion: "huangque.probe.v1",
    sourceId: candidate.id,
    probedAt,
    verificationState,
    collectable: verificationState === "verified",
    strategy,
    collectionEndpoint,
    publisher: candidate.publisher || candidate.tenant || new URL(candidate.sourceRootUrl).hostname,
    robots,
    http: httpObservation,
    evidence,
    evidenceHash,
    errors: verificationState === "verified" ? [] : [publicSearchBusinessError
      ? `公开招聘查询返回业务错误 ${inspection.payload?.code ?? "unknown"}`
      : `探测未达到批准门槛：${verificationState}`],
    edges,
    sourceClues,
    sampleJobs,
    counts: {
      total: inspection.totalRows || pageSignals.jobLinks.length,
      china: inspection.chinaRows || (scopeVerified ? pageSignals.jobLinks.length : 0),
      beijing: inspection.beijingRows || 0,
    },
  };
}
