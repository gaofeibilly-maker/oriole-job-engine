import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { extractChinaRegionSignals } from "./china-regions.mjs";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "from",
  "gh_src",
  "gclid",
  "lever-source",
  "ref",
  "referrer",
  "source",
  "spm",
]);

const RECRUITMENT_TERMS = /招聘|岗位|职位|人才|就业|career|careers|hiring|job|jobs|recruit/i;
const CHINA_TERMS = /中国|全国|大陆|内地|北京|上海|天津|重庆|省|自治区|China|Beijing|Shanghai|Tianjin|Chongqing/i;
const LOGIN_OR_BLOCKED_TERMS = /\/login(?:\/|$)|\/signin(?:\/|$)|验证码|仅限登录|付费墙/i;

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 14)}`;
}

function normalizePath(pathname) {
  const normalized = pathname.replace(/\/{2,}/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/$/, "");
}

// Keep IPv4 and IPv6 rules in separate BlockList instances. Node maps IPv4
// values into IPv6 before checking a mixed list; an IPv4-mapped IPv6 subnet
// would therefore accidentally block every public IPv4 address.
const BLOCKED_IPV4_ADDRESSES = new BlockList();
const BLOCKED_IPV6_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) BLOCKED_IPV4_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fec0::", 10], ["fe80::", 10], ["ff00::", 8],
]) BLOCKED_IPV6_ADDRESSES.addSubnet(network, prefix, "ipv6");

function mappedIpv4Address(host) {
  const match = host.match(/^(?:::ffff:|(?:0{1,4}:){5}ffff:)(.+)$/i);
  if (!match) return null;
  const tail = match[1];
  if (isIP(tail) === 4) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return true;
  const version = isIP(host);
  if (version === 4) return BLOCKED_IPV4_ADDRESSES.check(host, "ipv4");
  if (version !== 6) return false;
  const mapped = mappedIpv4Address(host);
  if (mapped) return BLOCKED_IPV4_ADDRESSES.check(mapped, "ipv4");
  return BLOCKED_IPV6_ADDRESSES.check(host, "ipv6");
}

export function canonicalizeUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password || isPrivateOrLocalHost(url.hostname)) return null;

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  url.pathname = normalizePath(url.pathname);
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMETERS.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, entryValue] of kept) url.searchParams.append(key, entryValue);
  return url.toString();
}

const TENANT_SCOPED_PROVIDERS = new Set(["Lever", "Greenhouse", "Ashby"]);

function canonicalOrigin(value) {
  const canonical = canonicalizeUrl(value);
  if (!canonical) return null;
  try { return new URL(canonical).origin; } catch { return null; }
}

export function trustedSourceOrigins(source) {
  const candidate = source?.candidate || source || {};
  return new Set([
    candidate.sourceRootUrl,
    candidate.publicApiUrl,
  ].map(canonicalOrigin).filter(Boolean));
}

function pathTenant(url, provider) {
  let segments;
  try {
    segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment).toLowerCase());
  } catch {
    return null;
  }
  if (provider === "Lever") {
    if (url.hostname === "jobs.lever.co") return segments[0] || null;
    if (url.hostname === "api.lever.co" && segments[0] === "v0" && segments[1] === "postings") return segments[2] || null;
  }
  if (provider === "Greenhouse") {
    if (url.hostname === "job-boards.greenhouse.io" || url.hostname === "boards.greenhouse.io") return segments[0] || null;
    if (url.hostname === "boards-api.greenhouse.io" && segments[0] === "v1" && segments[1] === "boards") return segments[2] || null;
  }
  if (provider === "Ashby") {
    if (url.hostname === "jobs.ashbyhq.com") return segments[0] || null;
    if (url.hostname === "api.ashbyhq.com" && segments[0] === "posting-api" && segments[1] === "job-board") return segments[2] || null;
  }
  return null;
}

/**
 * A job link may point only to an origin that was part of the approved source
 * probe, or to the fixed public job host of a supported ATS adapter. A link to
 * another origin is a new source and must be probed/approved separately.
 */
export function sourceOwnsJobUrl(source, value) {
  const canonical = canonicalizeUrl(value);
  if (!canonical) return false;
  const url = new URL(canonical);
  if (url.protocol !== "https:") return false;
  const provider = source?.candidate?.provider || source?.provider;
  const candidate = source?.candidate || source || {};
  if (TENANT_SCOPED_PROVIDERS.has(provider)) {
    const tenant = String(candidate.tenant || "").toLowerCase();
    return url.protocol === "https:" && Boolean(tenant) && pathTenant(url, provider) === tenant;
  }
  // NCSS operates the national board and multiple official sub-sites on
  // ncss.cn. Cross-subdomain job links are accepted, but an look-alike suffix
  // such as ncss.cn.example is not.
  if (provider === "NCSS") {
    return url.protocol === "https:" && (url.hostname === "ncss.cn" || url.hostname.endsWith(".ncss.cn"));
  }
  if (provider === "BeijingPublicEmployment" && url.protocol === "https:" && url.hostname === "fuwu.rsj.beijing.gov.cn") return true;
  return trustedSourceOrigins(source).has(url.origin);
}

function tenantFromPath(pathname, index = 0) {
  return pathname.split("/").filter(Boolean)[index] || null;
}

export function detectAts(value) {
  const canonicalUrl = canonicalizeUrl(value);
  if (!canonicalUrl) return null;
  const url = new URL(canonicalUrl);
  const host = url.hostname;

  if (host === "jobs.lever.co") {
    const tenant = tenantFromPath(url.pathname);
    if (!tenant) return null;
    return {
      provider: "Lever",
      tenant,
      sourceKey: `ats:lever:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://jobs.lever.co/${tenant}`,
      publicApiUrl: `https://api.lever.co/v0/postings/${tenant}?mode=json`,
    };
  }
  if (host === "api.lever.co" && /^\/v0\/postings\//.test(url.pathname)) {
    const tenant = tenantFromPath(url.pathname, 2);
    if (!tenant) return null;
    return {
      provider: "Lever",
      tenant,
      sourceKey: `ats:lever:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://jobs.lever.co/${tenant}`,
      publicApiUrl: `https://api.lever.co/v0/postings/${tenant}?mode=json`,
    };
  }

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const tenant = tenantFromPath(url.pathname);
    if (!tenant) return null;
    return {
      provider: "Greenhouse",
      tenant,
      sourceKey: `ats:greenhouse:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://job-boards.greenhouse.io/${tenant}`,
      publicApiUrl: `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=false`,
    };
  }
  if (host === "boards-api.greenhouse.io" && /^\/v1\/boards\//.test(url.pathname)) {
    const tenant = tenantFromPath(url.pathname, 2);
    if (!tenant) return null;
    return {
      provider: "Greenhouse",
      tenant,
      sourceKey: `ats:greenhouse:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://job-boards.greenhouse.io/${tenant}`,
      publicApiUrl: `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=false`,
    };
  }

  if (host === "jobs.ashbyhq.com") {
    const tenant = tenantFromPath(url.pathname);
    if (!tenant) return null;
    return {
      provider: "Ashby",
      tenant,
      sourceKey: `ats:ashby:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://jobs.ashbyhq.com/${tenant}`,
      publicApiUrl: `https://api.ashbyhq.com/posting-api/job-board/${tenant}`,
    };
  }
  if (host === "api.ashbyhq.com" && /^\/posting-api\/job-board\//.test(url.pathname)) {
    const tenant = tenantFromPath(url.pathname, 2);
    if (!tenant) return null;
    return {
      provider: "Ashby",
      tenant,
      sourceKey: `ats:ashby:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://jobs.ashbyhq.com/${tenant}`,
      publicApiUrl: `https://api.ashbyhq.com/posting-api/job-board/${tenant}`,
    };
  }

  if (host.endsWith(".myworkdayjobs.com")) {
    const tenant = host.split(".")[0];
    return {
      provider: "Workday",
      tenant,
      sourceKey: `ats:workday:${host}`,
      sourceRootUrl: `${url.protocol}//${host}`,
      publicApiUrl: null,
    };
  }

  if (host === "careers.smartrecruiters.com") {
    const tenant = tenantFromPath(url.pathname);
    if (!tenant) return null;
    return {
      provider: "SmartRecruiters",
      tenant,
      sourceKey: `ats:smartrecruiters:${tenant.toLowerCase()}`,
      sourceRootUrl: `https://careers.smartrecruiters.com/${tenant}`,
      publicApiUrl: null,
    };
  }

  return null;
}

function isGovernmentHost(hostname) {
  return hostname === "gov.cn" || hostname.endsWith(".gov.cn");
}

function governmentSourceRoot(url) {
  if (url.hostname === "job.mohrss.gov.cn") {
    if (/listJobinfolist|listInstitution/i.test(url.pathname)) return canonicalizeUrl(url.toString());
    return "https://job.mohrss.gov.cn/";
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const dateDirectory = segments.findIndex((segment) => /^20\d{4}$/.test(segment));
  if (dateDirectory >= 0) {
    const rootPath = segments.slice(0, dateDirectory).join("/");
    return canonicalizeUrl(`${url.origin}/${rootPath}${rootPath ? "/" : ""}`);
  }
  if (/\/t20\d{6}_\d+\.html$/i.test(url.pathname)) {
    return canonicalizeUrl(`${url.origin}${url.pathname.replace(/\/t20\d{6}_\d+\.html$/i, "/")}`);
  }
  return canonicalizeUrl(url.toString());
}

function detectPublicService(value) {
  const canonicalUrl = canonicalizeUrl(value);
  if (!canonicalUrl) return null;
  const url = new URL(canonicalUrl);
  if (url.hostname === "www.ncss.cn" && url.pathname.startsWith("/student/jobs/")) {
    return {
      provider: "NCSS",
      tenant: "china-jobs",
      systemType: "public_service",
      sourceKey: "public:ncss:jobs:china",
      sourceRootUrl: "https://www.ncss.cn/student/jobs/index.html",
      publicApiUrl: "https://www.ncss.cn/student/jobs/jobslist/ajax/?offset=1&limit=10",
      canonicalUrl,
    };
  }
  if (url.hostname === "fuwu.rsj.beijing.gov.cn" && /\/jycy\/jycs\/(?:kyjp\.html|zyjp\/getTblb)/i.test(url.pathname)) {
    return {
      provider: "BeijingPublicEmployment",
      tenant: "beijing-public-jobs",
      systemType: "public_service",
      sourceKey: "public:beijing-rsj:jobs",
      sourceRootUrl: "https://fuwu.rsj.beijing.gov.cn/jycy/jycs/kyjp.html",
      publicApiUrl: "https://fuwu.rsj.beijing.gov.cn/jycy/jycs/zyjp/getTblb",
      canonicalUrl,
    };
  }
  return null;
}

export function deriveSourceIdentity(value) {
  const canonicalUrl = canonicalizeUrl(value);
  if (!canonicalUrl) return null;
  const ats = detectAts(canonicalUrl);
  if (ats) return { ...ats, systemType: "ats", canonicalUrl };
  const publicService = detectPublicService(canonicalUrl);
  if (publicService) return publicService;

  const url = new URL(canonicalUrl);
  const sourceRootUrl = isGovernmentHost(url.hostname)
    ? governmentSourceRoot(url)
    : canonicalUrl;
  return {
    provider: null,
    tenant: null,
    systemType: null,
    sourceKey: `url:${sourceRootUrl.toLowerCase()}`,
    sourceRootUrl,
    publicApiUrl: null,
    canonicalUrl,
  };
}

function resultText(result) {
  return [result.query, result.title, result.snippet, result.url].filter(Boolean).join(" ");
}

function recencyWeight(publishedAt, observedAt) {
  if (!publishedAt || !observedAt) return 0;
  const published = new Date(publishedAt);
  const observed = new Date(observedAt);
  if (Number.isNaN(published.getTime()) || Number.isNaN(observed.getTime())) return 0;
  const ageDays = Math.floor((observed.getTime() - published.getTime()) / 86_400_000);
  if (ageDays < 0) return 0;
  if (ageDays <= 30) return 8;
  if (ageDays <= 180) return 4;
  return 0;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isLikelyDetailUrl(value) {
  const url = new URL(value);
  const pathname = url.pathname;
  if (/(?:index(?:_\d+)?|list[^/]*)\.s?html$/i.test(pathname) || /\/kyjp\.html$/i.test(pathname)) return false;
  if (/\/(?:article\/)?\d+\.s?html$/i.test(pathname)) return true;
  if (/\/t20\d{6}_\d+\.s?html$/i.test(pathname)) return true;
  if (/\.s?html$/i.test(pathname) && /20\d{4}|detail|info\d+/i.test(pathname)) return true;
  return false;
}

function flattenDiscoveryInput(input) {
  if (!input || typeof input !== "object") throw new TypeError("发现输入必须是 JSON 对象");
  if (input.schemaVersion && input.schemaVersion !== "huangque.discovery-input.v1") {
    throw new TypeError(`不支持的发现输入版本：${input.schemaVersion}`);
  }
  if (!Array.isArray(input.queries) && !Array.isArray(input.results)) {
    throw new TypeError("发现输入必须包含 queries[] 或 results[]");
  }
  const queries = Array.isArray(input.queries)
    ? input.queries
    : [{ id: "flat-results", query: input.query || "", results: input.results }];

  const flattened = [];
  for (const [queryIndex, query] of queries.entries()) {
    if (!query || typeof query !== "object" || !Array.isArray(query.results)) {
      throw new TypeError(`查询 ${queryIndex + 1} 必须包含 results[]`);
    }
    const queryId = String(query.id || `query-${queryIndex + 1}`);
    const results = query.results;
    for (const [resultIndex, result] of results.entries()) {
      if (!result || typeof result !== "object") continue;
      flattened.push({
        queryId,
        query: String(query.query || ""),
        channel: String(query.channel || input.metadata?.provider || "imported_search_results"),
        rank: Number(result.rank || resultIndex + 1),
        title: String(result.title || "").trim(),
        snippet: String(result.snippet || "").trim(),
        url: String(result.url || "").trim(),
        publishedAt: result.publishedAt || null,
        dimensions: result.dimensions || query.dimensions || {},
        providerEvidence: result.providerEvidence || result.evidence || null,
      });
    }
  }
  return flattened;
}

function knownSourceMap(knownSnapshot) {
  const map = new Map();
  for (const source of knownSnapshot?.sources || []) {
    const identity = deriveSourceIdentity(source.publicUrl);
    if (!identity) continue;
    map.set(identity.sourceKey, {
      id: source.id,
      name: source.name,
      provider: source.provider,
      publicUrl: source.publicUrl,
    });
  }
  return map;
}

function classifyGroup(group, observedAt, known) {
  const primary = group.results.slice().sort((left, right) => left.rank - right.rank)[0];
  const identity = group.identity;
  const url = new URL(identity.sourceRootUrl);
  const combinedText = group.results.map(resultText).join(" ");
  const isGovernment = isGovernmentHost(url.hostname);
  const declaredRegions = group.results.flatMap((result) => {
    const evidence = result.providerEvidence || {};
    if (evidence.regionCode === "CN" || evidence.coverageRegions === "all_provincial_regions") {
      return [{ countryCode: "CN", provinceCode: null, provinceName: null, cityCode: null, cityName: null, label: "全国", remote: false, confidence: 1, basis: "official_catalog" }];
    }
    if (!evidence.region) return [];
    return extractChinaRegionSignals(evidence.region).map((region) => ({ ...region, confidence: 1, basis: "official_catalog" }));
  });
  const regions = declaredRegions.length
    ? [...new Map(declaredRegions.map((region) => [`${region.provinceCode || "CN"}:${region.cityCode || "ALL"}`, region])).values()]
    : extractChinaRegionSignals(combinedText);
  const hasChina = regions.length > 0 || CHINA_TERMS.test(combinedText) || /\.gov\.cn$/.test(url.hostname);
  const hasRecruitment = RECRUITMENT_TERMS.test(combinedText);
  const isBlocked = LOGIN_OR_BLOCKED_TERMS.test(`${url.pathname} ${combinedText}`);
  const isAts = identity.systemType === "ats";
  const isTrustedPublicService = identity.systemType === "public_service";
  const isPublicEmployment = isTrustedPublicService || (isGovernment && /就业|招聘会|job\.mohrss|就业服务/i.test(`${combinedText} ${url.hostname}`));
  const isCommunityHub = hasChina && hasRecruitment && /社区|街道|就业服务站|零工驿站/i.test(combinedText);
  const isParkOrAssociation = hasChina && hasRecruitment && /产业园|园区|商圈|协会|商会/i.test(combinedText);
  const hasMultipleQueries = group.queryIds.length > 1;
  const hasStableListingObservation = group.results.some((result) => {
    const resultUrl = canonicalizeUrl(result.url);
    return (resultUrl === canonicalizeUrl(identity.sourceRootUrl) && !isLikelyDetailUrl(resultUrl))
      || /\/(jobs?|careers?|recruit(?:ment)?|招聘|gkzp)(?:\/|$)/i.test(new URL(resultUrl).pathname);
  }) || Boolean(identity.publicApiUrl);
  const recentWeight = Math.max(...group.results.map((result) => recencyWeight(result.publishedAt, observedAt)), 0);

  let sourceType = "unknown_public_page";
  let authority = "unknown";
  let collectionStrategy = "manual_source_review";
  let endpointType = "unknown";
  if (isAts) {
    sourceType = "official_ats";
    authority = "employer_controlled_board";
    collectionStrategy = identity.publicApiUrl ? "public_ats_api" : "ats_board_probe";
    endpointType = identity.publicApiUrl ? "api_feed" : "job_list";
  } else if (isPublicEmployment && hasStableListingObservation) {
    sourceType = "government_public_employment";
    authority = isTrustedPublicService ? "official_public_service" : "official_government";
    collectionStrategy = identity.publicApiUrl ? "public_json_api" : "listing_and_attachment_probe";
    endpointType = identity.publicApiUrl ? "api_feed" : "job_list";
  } else if (isGovernment && hasRecruitment && hasStableListingObservation) {
    sourceType = "government_recruitment_hub";
    authority = "official_government";
    collectionStrategy = "listing_and_attachment_probe";
    endpointType = "job_list";
  } else if (isGovernment && hasRecruitment) {
    sourceType = "single_government_post";
    authority = "official_government";
    collectionStrategy = "find_parent_listing";
    endpointType = "detail";
  } else if (isCommunityHub) {
    sourceType = "community_recruitment_hub";
    authority = "needs_publisher_ownership_check";
    collectionStrategy = "listing_and_attachment_probe";
    endpointType = hasStableListingObservation ? "job_list" : "unknown";
  } else if (isParkOrAssociation) {
    sourceType = "park_or_association_board";
    authority = "needs_publisher_ownership_check";
    collectionStrategy = "listing_and_attachment_probe";
    endpointType = hasStableListingObservation ? "job_list" : "unknown";
  } else if (/career|careers|招聘|人才/i.test(`${url.pathname} ${combinedText}`)) {
    sourceType = "company_career_site";
    authority = "needs_domain_ownership_check";
    collectionStrategy = "jsonld_sitemap_html_probe";
    endpointType = hasStableListingObservation ? "job_list" : "unknown";
  }

  const signals = [];
  const addSignal = (code, label, weight, evidence) => signals.push({ code, label, weight, evidence });
  if (isAts) addSignal("known_ats", `识别为 ${identity.provider} 招聘系统`, 27, identity.sourceRootUrl);
  if (isTrustedPublicService) addSignal("known_public_service", `识别为 ${identity.provider} 官方公共就业平台`, 27, identity.sourceRootUrl);
  if (isGovernment) addSignal("government_domain", "政府官方域名", 30, url.hostname);
  if (hasChina) addSignal("china_scope", "结果明确指向中国境内岗位", 16, regions.map((region) => region.label).join("、") || "查询、标题、摘要、URL 或政府域名中出现中国地域信号");
  if (hasRecruitment) addSignal("recruitment_language", "包含招聘/岗位/就业信号", 12, primary.title || primary.url);
  if (isCommunityHub) addSignal("community_hub", "识别为社区或街道招聘栏目", 6, primary.title || primary.url);
  if (isParkOrAssociation) addSignal("park_association", "识别为园区或协会招聘栏目", 6, primary.title || primary.url);
  if (hasMultipleQueries) addSignal("multi_query", "由多个查询独立命中", 8, group.queryIds.join(", "));
  if (recentWeight) addSignal("recent_result", "搜索结果带近期发布时间", recentWeight, group.latestPublishedAt);
  if (identity.publicApiUrl) addSignal("deterministic_api", "存在可预测的公开 ATS 接口", 8, identity.publicApiUrl);
  if (!isAts && endpointType === "detail") addSignal("single_post_only", "当前只命中单篇公告，尚未找到稳定栏目", -12, primary.url);
  if (isBlocked) addSignal("access_restriction", "出现登录、验证码或访问限制信号", -45, primary.url);
  if (!hasChina) addSignal("missing_china_signal", "尚未发现明确中国境内范围信号", -18, primary.title || primary.url);

  const discoveryPriorityScore = clamp(10 + signals.reduce((total, signal) => total + signal.weight, 0));
  const hardReady = hasChina && hasRecruitment && (isAts || isTrustedPublicService || (isGovernment && hasStableListingObservation));
  let status = "backlog";
  if (known) status = "already_registered";
  else if (isBlocked) status = "rejected_access_restricted";
  else if (hardReady) status = "ready_for_probe";
  else if (hasChina && hasRecruitment) status = "needs_review";

  const reasonCodes = [];
  if (isAts) reasonCodes.push("KNOWN_PUBLIC_ATS_PATTERN");
  if (isTrustedPublicService) reasonCodes.push("KNOWN_PUBLIC_SERVICE_PATTERN");
  if (isGovernment) reasonCodes.push("OFFICIAL_GOVERNMENT_DOMAIN");
  if (isCommunityHub) reasonCodes.push("COMMUNITY_RECRUITMENT_HUB");
  if (isParkOrAssociation) reasonCodes.push("PARK_OR_ASSOCIATION_BOARD");
  if (hasChina) reasonCodes.push("CHINA_RELEVANT");
  if (hasRecruitment) reasonCodes.push("RECRUITMENT_RELEVANT");
  if (hasStableListingObservation || isAts) reasonCodes.push("REPEATABLE_ENDPOINT");
  if (known) reasonCodes.push("KNOWN_SOURCE_MATCH");
  if (endpointType === "detail") reasonCodes.push("SINGLE_POST_NEEDS_PARENT");
  if (isBlocked) reasonCodes.push("ACCESS_RESTRICTED");

  const labels = unique(group.results.map((result) => result.title));
  const observedPublisher = group.results.map((result) => result.providerEvidence?.publisher).find(Boolean) || null;
  const name = isAts
    ? `${identity.tenant} · ${identity.provider}`
    : labels[0] || url.hostname;

  return {
    schemaVersion: "huangque.candidate-source.v1",
    id: stableId("huangque", identity.sourceKey),
    name,
    publisher: observedPublisher || identity.tenant || null,
    publisherKey: observedPublisher ? `publisher:${stableId("name", observedPublisher)}` : `host:${url.hostname}`,
    sourceKey: identity.sourceKey,
    entryUrl: canonicalizeUrl(primary.url),
    sourceRootUrl: identity.sourceRootUrl,
    provider: identity.provider,
    tenant: identity.tenant,
    publicApiUrl: identity.publicApiUrl,
    sourceType,
    endpointType,
    authority,
    collectionStrategy,
    discoveryPriorityScore,
    verificationState: "unverified_candidate",
    status,
    decision: {
      status,
      reasonCodes,
      decidedBy: "deterministic_rules_v1",
    },
    registryMatch: known
      ? { status: "known", sourceId: known.id, matchedBy: "source_key" }
      : { status: "new", sourceId: null, matchedBy: null },
    knownSource: known || null,
    scopeSignals: regions.length ? regions.map((region) => region.label) : hasChina ? ["全国"] : [],
    regions: regions.length ? regions : hasChina ? [{ countryCode: "CN", provinceCode: null, provinceName: null, cityCode: null, cityName: null, label: "全国", confidence: 0.7, basis: "discovery_text" }] : [],
    queryIds: group.queryIds,
    discoveredUrls: unique(group.results.map((result) => canonicalizeUrl(result.url))),
    titles: labels.slice(0, 6),
    latestPublishedAt: group.latestPublishedAt,
    signals,
    evidence: group.results.map((result) => ({
      queryId: result.queryId,
      query: result.query,
      channel: result.channel,
      rank: result.rank,
      url: canonicalizeUrl(result.url),
      title: result.title,
      snippet: result.snippet,
      publishedAt: result.publishedAt,
      providerEvidence: result.providerEvidence,
      dimensions: result.dimensions,
    })),
    nextAction: status === "already_registered"
      ? "与现有来源比对覆盖范围，不重复注册"
      : status === "ready_for_probe"
        ? collectionStrategy === "public_ats_api"
          ? "探测公开 ATS 接口，确认中国境内岗位数量、更新时间和申请入口"
          : collectionStrategy === "public_json_api"
            ? "探测公开 JSON 的分页、字段、更新时间和上游来源标识"
            : "检查栏目分页、附件和发布日期结构，再决定采集适配器"
        : status === "needs_review"
          ? "人工确认发布主体与稳定栏目入口"
          : status === "rejected_access_restricted"
            ? "不绕过访问限制；寻找官方公开替代入口"
            : "保留为低优先候选，等待更多证据",
  };
}

export function discoverSourceCandidates(input, { knownSnapshot = null, observedAt = null } = {}) {
  const effectiveObservedAt = observedAt || input?.metadata?.observedAt || new Date().toISOString();
  if (Number.isNaN(new Date(effectiveObservedAt).getTime())) throw new TypeError("observedAt 必须是有效日期");

  const flattened = flattenDiscoveryInput(input);
  const invalidResults = [];
  const groups = new Map();
  for (const result of flattened) {
    const identity = deriveSourceIdentity(result.url);
    if (!identity) {
      invalidResults.push({ queryId: result.queryId, url: result.url, reason: "invalid_or_unsupported_url" });
      continue;
    }
    const group = groups.get(identity.sourceKey) || { identity, results: [] };
    group.results.push(result);
    groups.set(identity.sourceKey, group);
  }

  const known = knownSourceMap(knownSnapshot);
  const candidates = [...groups.values()].map((group) => {
    group.queryIds = unique(group.results.map((result) => result.queryId));
    group.latestPublishedAt = group.results
      .map((result) => result.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return classifyGroup(group, effectiveObservedAt, known.get(group.identity.sourceKey));
  }).sort((left, right) => {
    const statusOrder = { ready_for_probe: 0, needs_review: 1, already_registered: 2, backlog: 3, rejected_access_restricted: 4 };
    return (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9)
      || right.discoveryPriorityScore - left.discoveryPriorityScore
      || left.sourceKey.localeCompare(right.sourceKey);
  });

  const countBy = (field) => Object.fromEntries([...new Set(candidates.map((candidate) => candidate[field] || "none"))]
    .sort()
    .map((value) => [value, candidates.filter((candidate) => (candidate[field] || "none") === value).length]));

  return {
    metadata: {
      schemaVersion: "huangque.discovery-run.v1",
      project: "黄雀",
      version: "0.1.0",
      scope: input?.metadata?.scope || "全国",
      observedAt: effectiveObservedAt,
      inputProvider: input?.metadata?.provider || "imported_search_results",
      definition: "搜索结果只用于发现候选招聘源；候选源未经过探测前，不代表可靠、可采集或存在有效岗位。",
    },
    stats: {
      inputResults: flattened.length,
      validResults: flattened.length - invalidResults.length,
      invalidResults: invalidResults.length,
      candidateSources: candidates.length,
      readyForProbe: candidates.filter((candidate) => candidate.status === "ready_for_probe").length,
      needsReview: candidates.filter((candidate) => candidate.status === "needs_review").length,
      alreadyRegistered: candidates.filter((candidate) => candidate.status === "already_registered").length,
      backlog: candidates.filter((candidate) => candidate.status === "backlog").length,
      rejected: candidates.filter((candidate) => candidate.status.startsWith("rejected_")).length,
      bySourceType: countBy("sourceType"),
      byProvider: countBy("provider"),
    },
    invalidResults,
    candidates,
  };
}

function escapeMarkdown(value = "") {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderDiscoveryReport(discovery) {
  const lines = [
    "# 黄雀 Oriole：全国招聘信息源发现报告",
    "",
    `生成时间：${discovery.metadata.observedAt}`,
    "",
    `> ${discovery.metadata.definition}`,
    "",
    "## 本轮结果",
    "",
    `- 输入搜索结果：${discovery.stats.inputResults} 条`,
    `- 归一后的候选来源：${discovery.stats.candidateSources} 个`,
    `- 可进入自动探测：${discovery.stats.readyForProbe} 个`,
    `- 需要人工确认：${discovery.stats.needsReview} 个`,
    `- 已在现有岗位快照注册：${discovery.stats.alreadyRegistered} 个`,
    "",
    "## 候选来源",
    "",
    "| 状态 | 来源 | 类型 | 优先级 | 发现证据 | 下一步 |",
    "|---|---|---|---:|---:|---|",
  ];

  for (const candidate of discovery.candidates) {
    const reviewUrl = candidate.endpointType === "detail" ? candidate.entryUrl : candidate.sourceRootUrl;
    lines.push(`| ${escapeMarkdown(candidate.status)} | [${escapeMarkdown(candidate.name)}](${reviewUrl}) | ${escapeMarkdown(candidate.sourceType)} | ${candidate.discoveryPriorityScore} | ${candidate.evidence.length} | ${escapeMarkdown(candidate.nextAction)} |`);
  }

  lines.push(
    "",
    "## 解释边界",
    "",
    "- `discoveryPriorityScore` 只表示值得优先检查，不是来源可信度，也不是岗位有效性分数。",
    "- `ready_for_probe` 表示可进入下一步自动探测；只有探测成功并人工抽检后，才能注册为长期来源。",
    "- 系统不会绕过登录、验证码、付费墙或其他访问限制。",
    "- 已注册来源会被识别并保留为覆盖对照，不会重复接入。",
    "",
  );
  return lines.join("\n");
}
