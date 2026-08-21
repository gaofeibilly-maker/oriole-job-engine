import { createHash } from "node:crypto";
import { normalizeAdapterPayload, plainText } from "./adapters.mjs";
import { fetchRobotsPolicy, isLocalControlError, robotsAllowsRules, safeFetch } from "./http.mjs";
import { canonicalizeUrl, sourceOwnsJobUrl } from "./source-discovery.mjs";

const LOGIN_OR_CHALLENGE = /login required|sign[ -]?in required|please log in|access denied|captcha|cloudflare challenge|验证码|请先登录|登录后查看|仅限登录|访问受限|付费墙/i;
const RECRUITMENT_LANGUAGE = /招聘|岗位|职位|招考|报名|录用|career|careers|job|jobs|hiring|position|opening/i;
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
  if (candidate.provider === "NCSS") return "ncss_public_json";
  if (candidate.provider === "BeijingPublicEmployment") return "beijing_public_employment_json";
  if (inspection.format === "xml" && inspection.totalRows > 0) return "xml_feed_or_sitemap";
  if (inspection.format === "html" && inspection.totalRows > 0) return "jobposting_jsonld";
  if (pageSignals.jobLinks.length > 0) return "listing_html";
  return "unsupported";
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
    return {
      schemaVersion: "huangque.probe.v1",
      sourceId: candidate.id,
      probedAt,
      verificationState: "blocked_robots",
      collectable: false,
      strategy: "none",
      robots,
      evidence: [{ kind: "robots", ...robots }],
      errors: ["robots.txt 明确禁止黄雀访问该路径"],
      edges: [],
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  let response;
  try {
    response = await safeFetch(targetUrl, {
      ...fetchOptions,
      ...requestOptions(candidate),
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

  const evidence = [
    { kind: "robots", ...robots },
    {
      kind: "http_observation",
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      status: response.status,
      contentType: response.contentType,
      bytes: response.bytes,
      contentHash: response.contentHash,
      redirectChain: response.redirectChain,
      fetchedAt: response.fetchedAt,
    },
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
      http: evidence[1],
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
      http: evidence[1],
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
      http: evidence[1],
      evidence,
      errors: ["页面正文显示需要登录、验证码或访问受限"],
      edges,
      sampleJobs: [],
      counts: { total: 0, china: 0, beijing: 0 },
    };
  }

  const discoveredPageEdges = [...pageSignals.edges];
  let normalized = normalizeProbeResponse(candidate, response, probedAt);
  let inspection = normalized.inspection;
  let collectionEndpoint = targetUrl;
  if (normalized.jobs.length === 0) {
    const alternativeUrls = [...new Set([
      ...(robots.sitemaps || []),
      ...pageSignals.edges.filter((edge) => edge.type === "feed" || edge.type === "sitemap").map((edge) => edge.to),
      ...(inspection.nestedSitemaps || []),
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
  const verificationState = unsafeJobOrigins > 0 ? "unsafe_job_origin"
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
    http: evidence[1],
    evidence,
    evidenceHash,
    errors: verificationState === "verified" ? [] : [`探测未达到批准门槛：${verificationState}`],
    edges,
    sampleJobs,
    counts: {
      total: inspection.totalRows || pageSignals.jobLinks.length,
      china: inspection.chinaRows || (scopeVerified ? pageSignals.jobLinks.length : 0),
      beijing: inspection.beijingRows || 0,
    },
  };
}
