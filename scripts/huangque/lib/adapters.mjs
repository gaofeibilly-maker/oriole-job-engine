import { createHash } from "node:crypto";
import { canonicalizeUrl, sourceOwnsJobUrl, trustedSourceOrigins } from "./source-discovery.mjs";
import { exactJobMergeKey, jobsCanExactMerge, normalizedJobText, softJobIdentity } from "./job-identity.mjs";
import { classifyChinaLocations, normalizeJobRegions, rowLocatedInChina, structuredJobLocationValues } from "./china-regions.mjs";

export const MAX_JSON_ROWS_PER_PAGE = 5_000;
export const MAX_JSON_STRUCTURAL_TOKENS = 250_000;

export function jsonStructureWithinBudget(value, maximumTokens = MAX_JSON_STRUCTURAL_TOKENS) {
  let inString = false;
  let escaped = false;
  let tokens = 0;
  for (const character of String(value || "")) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{" || character === "[" || character === "," || character === ":") {
      tokens += 1;
      if (tokens > maximumTokens) return false;
    }
  }
  return true;
}

export function decodeHtml(value = "") {
  return String(value)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

export function plainText(value = "") {
  return decodeHtml(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li|h\d|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compact(value, max = 900) {
  const text = plainText(value);
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function stableJobId(sourceId, externalId, applyUrl, title, company, location) {
  const canonicalApplyUrl = canonicalizeUrl(applyUrl);
  const key = externalId || `${canonicalApplyUrl || "no-explicit-url"}\0${company}\0${title}\0${location}`;
  return `job-${createHash("sha256").update(`${sourceId}\0${key}`).digest("hex").slice(0, 20)}`;
}

function externalIdScalar(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

function iso(value) {
  if (!value && value !== 0) return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (/^\d{14}$/.test(String(value))) {
    const text = String(value);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageDays(value, observedAt) {
  const date = value ? new Date(value) : null;
  const observed = new Date(observedAt);
  if (!date || Number.isNaN(date.getTime()) || Number.isNaN(observed.getTime())) return null;
  return Math.max(0, Math.floor((observed.getTime() - date.getTime()) / 86_400_000));
}

function freshness(value, observedAt) {
  const age = ageDays(value, observedAt);
  if (age === null) return { label: "未提供发布时间", score: 82, state: "observed_on_active_listing" };
  if (age <= 7) return { label: `${age || "今天"}${age ? " 天前" : ""}更新`, score: 98, state: "recent" };
  if (age <= 30) return { label: `${age} 天前更新`, score: 95, state: "recent" };
  if (age <= 180) return { label: `${Math.floor(age / 30)} 个月前更新`, score: 86, state: "aging" };
  return { label: `${Math.floor(age / 30)} 个月前登记`, score: 68, state: "old_but_listed" };
}

function validThroughIso(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `${value}T23:59:59.999Z`;
  return iso(value);
}

function sourceTrust(source) {
  const type = source.candidate?.sourceType;
  if (type === "official_ats") return 99;
  if (/government|public/.test(type || "")) return 98;
  if (type === "company_career_site") return 92;
  return 75;
}

/** @deprecated Kept as a compatibility helper for older hosts and fixtures. */
export function rowLocatedInBeijing(row) {
  return classifyChinaLocations(structuredJobLocationValues(row)).regions.some((region) => region.provinceCode === "110000");
}

function authoritativeScopeRegions(candidate) {
  if (!candidate || !/^official_/.test(String(candidate.authority || ""))) return [];
  if (candidate.provider === "BeijingPublicEmployment") {
    return [{ countryCode: "CN", provinceCode: "110000", provinceName: "北京市", cityCode: null, cityName: null, label: "北京", confidence: 0.75, basis: "authoritative_source_scope" }];
  }
  return Array.isArray(candidate.regions) ? candidate.regions : [];
}

function makeJob(source, raw, observedAt, strategy) {
  const publishedAt = iso(raw.publishedAt);
  const validThrough = validThroughIso(raw.validThrough);
  const expired = Boolean(validThrough && new Date(validThrough).getTime() < new Date(observedAt).getTime());
  const fresh = expired
    ? { label: "有效期已结束", score: 0, state: "expired" }
    : freshness(publishedAt, observedAt);
  const explicitJobUrl = canonicalizeUrl(raw.applyUrl || raw.sourceUrl);
  const usesSourceFallback = raw.urlIsFallback === true || !explicitJobUrl;
  const applyUrl = explicitJobUrl || canonicalizeUrl(source.candidate?.sourceRootUrl) || source.candidate?.sourceRootUrl;
  const sourceUrl = canonicalizeUrl(raw.sourceUrl || applyUrl) || applyUrl;
  const company = compact(raw.company || source.probe?.publisher || source.name || "发布单位待核验", 300) || "发布单位待核验";
  const title = compact(raw.title || "未命名岗位", 500) || "未命名岗位";
  const normalizedLocations = normalizeJobRegions(raw, source);
  const workLocations = normalizedLocations.regions;
  const locationRawValues = normalizedLocations.rawValues || structuredJobLocationValues(raw);
  const locationRaw = locationRawValues.join(" · ") || compact(raw.location || "地点未提供", 600) || "地点未提供";
  const location = workLocations.map((item) => item.label).join(" · ") || "地点待核验";
  const department = compact(raw.department || "未分类", 300) || "未分类";
  const employmentType = compact(raw.employmentType || "未说明", 200) || "未说明";
  const workplaceType = compact(raw.workplaceType || "未说明", 200) || "未说明";
  const salary = compact(raw.salary || "薪资未公开", 300) || "薪资未公开";
  const description = compact(raw.description || "来源当前仍公开展示该岗位。", 1_200);
  const externalId = externalIdScalar(raw.externalId);
  const authenticityScore = sourceTrust(source);
  return {
    schemaVersion: "huangque.job.v2",
    id: stableJobId(source.id, externalId, usesSourceFallback ? null : applyUrl, title, company, location),
    sourceId: source.id,
    sourceKey: source.sourceKey,
    externalId,
    company,
    title,
    location,
    locationRaw,
    workLocations,
    regions: workLocations,
    regionProvince: workLocations[0]?.provinceName || null,
    regionProvinceCode: workLocations[0]?.provinceCode || null,
    regionCity: workLocations[0]?.cityName || null,
    regionCityCode: workLocations[0]?.cityCode || null,
    regionLabel: workLocations[0]?.label || "地点待核验",
    locationConfidence: workLocations.length ? Math.min(...workLocations.map((item) => Number(item.confidence || 0))) : 0,
    locationBasis: workLocations.some((region) => region.basis === "ambiguous_city_needs_review")
      ? "ambiguous_city_needs_review"
      : normalizedLocations.inferenceSource === "job_title"
      ? "job_title_location"
      : normalizedLocations.inferred ? "authoritative_source_scope" : "explicit_location",
    department,
    employmentType,
    workplaceType,
    salary,
    sourceUrl,
    applyUrl,
    urlIdentity: usesSourceFallback ? "source_fallback" : "job",
    publishedAt,
    validThrough,
    observedAt,
    description,
    status: expired ? "closed" : "confirmed_active",
    freshness: fresh.label,
    freshnessState: fresh.state,
    activeScore: fresh.score,
    authenticityScore,
    channelScore: Math.max(70, authenticityScore - 2),
    parser: strategy,
    contentHash: createHash("sha256").update(JSON.stringify({ title, company, location, workLocations, department, employmentType, workplaceType, salary, publishedAt, validThrough, applyUrl, description })).digest("hex"),
    evidence: [
      {
        kind: "source_observation",
        sourceId: source.id,
        observedAt,
        strategy,
        url: sourceUrl,
      },
      ...(raw.evidence || []),
    ],
  };
}

function leverRows(payload) {
  return Array.isArray(payload) ? payload : [];
}

function greenhouseRows(payload) {
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

function ashbyRows(payload) {
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

function feishuRecruitmentRows(payload) {
  return Array.isArray(payload?.data?.job_post_list) ? payload.data.job_post_list : [];
}

function feishuPortalRoot(source, fallbackUrl) {
  const candidate = source?.candidate || {};
  const origin = new URL(candidate.sourceRootUrl || fallbackUrl).origin;
  let path = null;
  try {
    const root = new URL(candidate.sourceRootUrl);
    const segment = root.pathname.split("/").filter(Boolean)[0];
    if (segment && !["api", "atsx", "m", "position"].includes(decodeURIComponent(segment).toLowerCase())) path = segment;
  } catch {
    // Older/manual source records may only have portalPath; use it below.
  }
  if (!path && typeof candidate.portalPath === "string" && candidate.portalPath.trim()) {
    path = encodeURIComponent(candidate.portalPath.trim());
  }
  return `${origin}/${path || "index"}`;
}

function flexibleRows(payload) {
  if (Array.isArray(payload)) return payload;
  const paths = [
    payload?.jobs, payload?.data?.jobs, payload?.data?.job_post_list, payload?.data?.list, payload?.data?.records,
    payload?.result?.jobs, payload?.result?.list, payload?.returnData?.tblb, payload?.rows,
  ];
  return paths.find(Array.isArray) || [];
}

function knownPublicJsonSchema(provider, payload) {
  if (provider === "NCSS") {
    return [payload?.jobs, payload?.data?.jobs, payload?.data?.list, payload?.data?.records, payload?.result?.jobs, payload?.result?.list, payload?.rows].some(Array.isArray);
  }
  if (provider === "BeijingPublicEmployment") {
    return [payload?.returnData?.tblb, payload?.data?.list, payload?.data?.records, payload?.rows].some(Array.isArray);
  }
  return false;
}

export function parseJsonLdJobs(html, baseUrl) {
  const jobs = [];
  const scripts = String(html || "").match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const raw = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    let payload;
    try {
      payload = JSON.parse(decodeHtml(raw));
    } catch {
      continue;
    }
    const queue = Array.isArray(payload) ? [...payload] : [payload];
    while (queue.length) {
      const item = queue.shift();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (!types.some((type) => String(type).toLowerCase() === "jobposting")) continue;
      const jobLocations = Array.isArray(item.jobLocation) ? item.jobLocation : [item.jobLocation].filter(Boolean);
      const workLocationsRaw = jobLocations.flatMap((entry) => {
        const address = entry?.address || {};
        return [[address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(", ") || entry?.name].filter(Boolean);
      });
      const location = workLocationsRaw.join(" · ") || "地点未提供";
      let applyUrl = item.url || item.sameAs || baseUrl;
      try { applyUrl = new URL(applyUrl, baseUrl).toString(); } catch { applyUrl = baseUrl; }
      jobs.push({
        externalId: item.identifier?.value || item.identifier || item["@id"] || null,
        title: item.title || item.name,
        company: item.hiringOrganization?.name || null,
        location,
        workLocationsRaw,
        department: item.industry || item.occupationalCategory || null,
        employmentType: Array.isArray(item.employmentType) ? item.employmentType.join(" · ") : item.employmentType,
        salary: item.baseSalary?.value?.value ? String(item.baseSalary.value.value) : null,
        publishedAt: item.datePosted || null,
        validThrough: item.validThrough || null,
        description: item.description || "",
        sourceUrl: applyUrl,
        applyUrl,
        urlIsFallback: !(item.url || item.sameAs),
      });
    }
  }
  return jobs;
}

export function parseHtmlListingJobs(html, baseUrl, sourceName = "") {
  const jobs = [];
  const seen = new Set();
  const anchors = String(html || "").match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const anchor of anchors) {
    const hrefMatch = anchor.match(/\bhref\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!hrefMatch) continue;
    const title = compact(plainText(anchor).replace(/\s+/g, " ").trim(), 500);
    if (!title || title.length < 4 || !/招聘|岗位|职位|招考|录用|career|job|hiring|position|opening/i.test(`${title} ${hrefMatch[2]}`)) continue;
    let url;
    try { url = canonicalizeUrl(new URL(hrefMatch[2], baseUrl).toString()); } catch { continue; }
    if (!url || seen.has(url) || /login|signin/i.test(url)) continue;
    seen.add(url);
    const aroundIndex = String(html).indexOf(anchor);
    const around = String(html).slice(Math.max(0, aroundIndex - 120), aroundIndex + anchor.length + 120);
    const dateMatch = plainText(around).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    const publishedAt = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}T00:00:00+08:00` : null;
    jobs.push({
      externalId: null,
      title,
      company: sourceName || null,
      location: "地点见公告",
      workLocationsRaw: [title, plainText(around)].filter(Boolean),
      publishedAt,
      description: "招聘公告或职位入口；具体岗位与报名条件以原页面及附件为准。",
      sourceUrl: url,
      applyUrl: url,
      evidence: [{ kind: "html_listing_anchor", anchorText: title, url }],
    });
  }
  return jobs.slice(0, 200);
}

function xmlElement(block, name) {
  const match = String(block).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? plainText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")) : "";
}

function xmlEntryLink(block, baseUrl) {
  const href = String(block).match(/<link\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
  const value = href || xmlElement(block, "link") || xmlElement(block, "loc");
  if (!value) return null;
  try { return canonicalizeUrl(new URL(value, baseUrl).toString()); } catch { return null; }
}

export function parseXmlListingJobs(xml, baseUrl, sourceName = "") {
  const jobs = [];
  const seen = new Set();
  const entries = String(xml).match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const entry of entries) {
    const applyUrl = xmlEntryLink(entry, baseUrl);
    const title = xmlElement(entry, "title");
    const description = xmlElement(entry, "description") || xmlElement(entry, "summary") || xmlElement(entry, "content");
    if (!applyUrl || seen.has(applyUrl) || !/招聘|岗位|职位|招考|录用|career|job|hiring|position|opening/i.test(`${title} ${description} ${applyUrl}`)) continue;
    seen.add(applyUrl);
    jobs.push({
      externalId: xmlElement(entry, "guid") || xmlElement(entry, "id") || applyUrl,
      title: title || "招聘职位入口",
      company: sourceName || null,
      location: "地点见原文",
      workLocationsRaw: [title].filter(Boolean),
      publishedAt: xmlElement(entry, "pubDate") || xmlElement(entry, "published") || xmlElement(entry, "updated") || null,
      description: description || "RSS/Atom 招聘条目；具体岗位和申请条件以原页面为准。",
      sourceUrl: applyUrl,
      applyUrl,
      evidence: [{ kind: "rss_atom_entry", url: applyUrl }],
    });
  }
  const sitemapUrls = String(xml).match(/<url\b[^>]*>[\s\S]*?<\/url>/gi) || [];
  for (const entry of sitemapUrls) {
    const applyUrl = xmlEntryLink(entry, baseUrl);
    if (!applyUrl || seen.has(applyUrl) || !/招聘|岗位|职位|career|careers|job|jobs|recruit|position|opening/i.test(applyUrl)) continue;
    seen.add(applyUrl);
    let slug = "招聘职位入口";
    try { slug = decodeURIComponent(new URL(applyUrl).pathname.split("/").filter(Boolean).at(-1) || slug).replace(/[-_]+/g, " "); }
    catch { slug = "招聘职位入口"; }
    jobs.push({
      externalId: applyUrl,
      title: slug || "招聘职位入口",
      company: sourceName || null,
      location: "地点见原文",
      workLocationsRaw: [applyUrl],
      publishedAt: xmlElement(entry, "lastmod") || null,
      description: "Sitemap 中的招聘职位入口；具体岗位和申请条件以原页面为准。",
      sourceUrl: applyUrl,
      applyUrl,
      evidence: [{ kind: "sitemap_url", url: applyUrl }],
    });
  }
  return jobs.slice(0, 500);
}

export function parseSitemapIndexUrls(xml, baseUrl) {
  const urls = [];
  for (const entry of String(xml || "").match(/<sitemap\b[^>]*>[\s\S]*?<\/sitemap>/gi) || []) {
    const value = xmlElement(entry, "loc");
    if (!value) continue;
    try {
      const url = canonicalizeUrl(new URL(value, baseUrl).toString());
      if (url && !urls.includes(url)) urls.push(url);
    } catch {
      // Ignore malformed child sitemap locations.
    }
  }
  return urls.slice(0, 50);
}

export function inspectPayload(provider, body, contentType = "", baseUrl = "") {
  const firstCharacter = String(body || "").trimStart()[0];
  if (/json/i.test(contentType) || firstCharacter === "[" || firstCharacter === "{") {
    if (!jsonStructureWithinBudget(body)) {
      return {
        format: "json",
        payload: null,
        rows: [],
        schemaRecognized: false,
        structuralLimitExceeded: true,
        totalRows: 0,
        chinaRows: 0,
        beijingRows: 0,
        maximumStructuralTokens: MAX_JSON_STRUCTURAL_TOKENS,
      };
    }
    try {
      const payload = JSON.parse(body);
      const rows = provider === "Lever" ? leverRows(payload)
        : provider === "Greenhouse" ? greenhouseRows(payload)
          : provider === "Ashby" ? ashbyRows(payload)
            : provider === "ByteDance" || provider === "FeishuRecruitment" ? feishuRecruitmentRows(payload)
            : flexibleRows(payload);
      if (rows.length > MAX_JSON_ROWS_PER_PAGE) {
        return {
          format: "json",
          payload: null,
          rows: [],
          schemaRecognized: false,
          rowLimitExceeded: true,
          totalRows: rows.length,
          chinaRows: 0,
          beijingRows: 0,
          maximumRows: MAX_JSON_ROWS_PER_PAGE,
        };
      }
      const schemaRecognized = provider === "Lever" ? Array.isArray(payload)
        : provider === "Greenhouse" || provider === "Ashby" ? Array.isArray(payload?.jobs)
          : provider === "ByteDance" || provider === "FeishuRecruitment" ? Array.isArray(payload?.data?.job_post_list)
          : knownPublicJsonSchema(provider, payload) || rows.length > 0;
      const chinaRows = rows.filter((row) => rowLocatedInChina(row)).length;
      return { format: "json", payload, rows, schemaRecognized, totalRows: rows.length, chinaRows, beijingRows: rows.filter(rowLocatedInBeijing).length };
    } catch (error) {
      return { format: "invalid_json", error: error.message, rows: [], totalRows: 0, chinaRows: 0, beijingRows: 0 };
    }
  }
  if (/xml/i.test(contentType) || /^\s*(?:<\?xml|<(?:rss|feed|urlset|sitemapindex)\b)/i.test(String(body || ""))) {
    const rows = parseXmlListingJobs(body, baseUrl);
    return { format: "xml", payload: null, rows, nestedSitemaps: parseSitemapIndexUrls(body, baseUrl), totalRows: rows.length, chinaRows: rows.filter((row) => rowLocatedInChina(row)).length, beijingRows: rows.filter(rowLocatedInBeijing).length };
  }
  const rows = parseJsonLdJobs(body, baseUrl);
  return { format: "html", payload: null, rows, totalRows: rows.length, chinaRows: rows.filter((row) => rowLocatedInChina(row)).length, beijingRows: rows.filter(rowLocatedInBeijing).length };
}

export function normalizeAdapterPayload(source, response, observedAt = new Date().toISOString()) {
  const provider = source.candidate?.provider;
  const inspection = inspectPayload(provider, response.body, response.contentType, response.finalUrl);
  let rawJobs = [];
  let strategy = "generic_json";
  const supportedAtsProviders = ["Lever", "Greenhouse", "Ashby", "ByteDance", "FeishuRecruitment"];
  if (source.candidate?.sourceType === "official_ats" && !supportedAtsProviders.includes(provider) && inspection.format === "json") {
    strategy = "unsupported_ats_json";
    rawJobs = [];
  } else if (provider === "Lever") {
    strategy = "lever_public_api";
    rawJobs = inspection.rows.map((row) => ({
      externalId: row.id,
      title: row.text,
      company: source.probe?.publisher || source.candidate?.tenant,
      location: row.categories?.location,
      workLocationsRaw: [row.categories?.location, row.location, row.locations],
      department: row.categories?.department || row.categories?.team,
      employmentType: row.categories?.commitment,
      workplaceType: row.workplaceType,
      publishedAt: row.createdAt,
      description: [row.descriptionPlain, row.openingPlain, row.descriptionBodyPlain, row.additionalPlain, ...(row.lists || []).map((list) => plainText(list.content || ""))].filter(Boolean).join("\n"),
      sourceUrl: row.hostedUrl,
      applyUrl: row.applyUrl || row.hostedUrl,
    }));
  } else if (provider === "Greenhouse") {
    strategy = "greenhouse_public_api";
    rawJobs = inspection.rows.map((row) => ({
      externalId: row.id,
      title: row.title,
      company: source.probe?.publisher || source.candidate?.tenant,
      location: row.location?.name,
      workLocationsRaw: [row.location, row.offices, row.metadata?.locations],
      department: row.departments?.map((item) => item.name).join(" · "),
      publishedAt: row.updated_at || row.first_published,
      description: row.content,
      sourceUrl: row.absolute_url,
      applyUrl: row.absolute_url,
    }));
  } else if (provider === "Ashby") {
    strategy = "ashby_public_api";
    rawJobs = inspection.rows.filter((row) => row.isListed !== false).map((row) => ({
      externalId: row.id,
      title: row.title,
      company: source.probe?.publisher || source.candidate?.tenant,
      location: row.location || row.address?.postalAddress?.addressLocality,
      workLocationsRaw: [row.location, row.secondaryLocations, row.address],
      department: row.department || row.team,
      employmentType: row.employmentType,
      workplaceType: row.workplaceType || (row.isRemote ? "Remote" : null),
      publishedAt: row.publishedAt,
      validThrough: row.validThrough,
      description: row.descriptionPlain || row.descriptionHtml,
      sourceUrl: row.jobUrl,
      applyUrl: row.applyUrl || row.jobUrl,
    }));
  } else if (provider === "ByteDance" || provider === "FeishuRecruitment") {
    strategy = provider === "ByteDance" ? "bytedance_public_search_api" : "feishu_recruitment_public_search_api";
    rawJobs = inspection.rows.map((row) => {
      const id = externalIdScalar(row.id || row.job_post_id || row.position_id);
      const origin = new URL(source.candidate?.sourceRootUrl || response.finalUrl).origin;
      const explicitUrl = row.job_url || row.job_post_url || row.position_url || row.url || null;
      let detailUrl = null;
      try { detailUrl = explicitUrl ? new URL(explicitUrl, origin).toString() : null; } catch { detailUrl = null; }
      if (!detailUrl && provider === "ByteDance" && id) detailUrl = `${origin}/experienced/position/${encodeURIComponent(id)}/detail`;
      if (!detailUrl && provider === "FeishuRecruitment" && id) detailUrl = `${feishuPortalRoot(source, response.finalUrl)}/position/${encodeURIComponent(id)}/detail`;
      const cityValues = [
        row.city_info?.name,
        ...(Array.isArray(row.city_list) ? row.city_list.map((item) => item?.name || item) : []),
        ...(Array.isArray(row.location_list) ? row.location_list.map((item) => item?.name || item) : []),
      ].filter(Boolean);
      const location = cityValues.join(" · ") || row.location?.name || row.location || "地点未提供";
      return {
        externalId: id,
        title: row.title || row.name,
        company: source.probe?.publisher || source.candidate?.publisher || (provider === "ByteDance" ? "字节跳动" : source.candidate?.tenant),
        location,
        workLocationsRaw: [row.city_info, row.city_list, row.location_list, row.location],
        department: row.job_category?.name || row.job_function?.name || row.department?.name || row.department,
        employmentType: row.recruit_type?.name || row.employment_type?.name || row.employment_type,
        workplaceType: row.workplace_type?.name || row.workplace_type,
        publishedAt: row.publish_time || row.publishTime || row.create_time,
        validThrough: row.job_post_info?.never_expiry ? null : row.job_post_info?.expiry_time,
        salary: row.job_post_info?.salary_min || row.job_post_info?.salary_max
          ? [row.job_post_info?.salary_min, row.job_post_info?.salary_max].filter((value) => value !== null && value !== undefined && value !== "").join("–")
          : null,
        description: [row.description, row.requirement, row.qualifications].filter(Boolean).join("\n\n"),
        sourceUrl: detailUrl || source.candidate?.sourceRootUrl,
        applyUrl: detailUrl || source.candidate?.sourceRootUrl,
        urlIsFallback: !detailUrl,
      };
    });
  } else if (provider === "BeijingPublicEmployment") {
    strategy = "beijing_public_employment_json";
    rawJobs = inspection.rows.map((row) => {
      const applyUrl = `https://fuwu.rsj.beijing.gov.cn/jycy/jycs/GwXq.html?zpgwid=${encodeURIComponent(row.zpgwid || row.id || "")}&dwid=${encodeURIComponent(row.dwid || "")}`;
      return {
        externalId: row.zpgwid || row.id,
        title: row.gwmc || row.jobName || row.name,
        company: row.dwmc || row.companyName,
        location: row.gzdd || row.areaName || "地点未提供",
        workLocationsRaw: [row.gzdd, row.areaName],
        salary: row.xc ? `${row.xc} 元/月` : null,
        publishedAt: row.gwdjsj || row.publishTime,
        description: row.gwms || row.description,
        sourceUrl: applyUrl,
        applyUrl,
      };
    });
  } else if (provider === "NCSS") {
    strategy = "ncss_public_json";
    rawJobs = inspection.rows.map((row) => ({
      externalId: row.jobId || row.id || row.positionId,
      title: row.jobName || row.name || row.positionName || row.title,
      company: row.companyName || row.corpName || row.unitName,
      location: row.areaName || row.city || row.address || "地点未提供",
      workLocationsRaw: [row.areaName, row.city, row.address],
      publishedAt: row.publishTime || row.createTime || row.date,
      description: row.description || row.jobDesc,
      sourceUrl: row.jobUrl || row.url || source.candidate?.sourceRootUrl,
      applyUrl: row.applyUrl || row.jobUrl || row.url || source.candidate?.sourceRootUrl,
      urlIsFallback: !(row.applyUrl || row.jobUrl || row.url),
    }));
  } else if (inspection.format === "xml") {
    strategy = /<(?:rss|feed)\b/i.test(response.body) ? "rss_atom_feed" : "sitemap_xml";
    rawJobs = inspection.rows;
  } else if (inspection.format === "html") {
    if (inspection.rows.length) {
      strategy = "jobposting_jsonld";
      rawJobs = inspection.rows;
    } else {
      strategy = "listing_html";
      rawJobs = parseHtmlListingJobs(response.body, response.finalUrl, source.name);
    }
  } else {
    strategy = "generic_public_json";
    rawJobs = inspection.rows.map((row) => ({
      externalId: row.id || row.jobId || row.positionId,
      title: row.title || row.name || row.jobName,
      company: row.company || row.companyName || row.organization,
      location: row.location?.name || row.location || row.city || row.address,
      workLocationsRaw: [row.location, row.locations, row.city, row.address, row.jobLocation],
      department: row.department || row.category,
      employmentType: row.employmentType || row.type,
      salary: row.salary,
      publishedAt: row.publishedAt || row.datePosted || row.updatedAt,
      validThrough: row.validThrough,
      description: row.description || row.content,
      sourceUrl: row.url || row.jobUrl,
      applyUrl: row.applyUrl || row.url || row.jobUrl,
    }));
  }
  const sourceRegions = authoritativeScopeRegions(source.candidate);
  let rejectedCrossOriginJobs = 0;
  const valid = rawJobs
    .filter((row) => row?.title)
    .filter((row) => rowLocatedInChina(row, { authoritativeRegions: sourceRegions }))
    .filter((row) => {
      const links = [row.sourceUrl, row.applyUrl].filter((value) => value !== undefined && value !== null && value !== "");
      const trusted = links.every((value) => sourceOwnsJobUrl(source, value));
      if (!trusted) rejectedCrossOriginJobs += 1;
      return trusted;
    });
  return {
    strategy,
    inspection: {
      ...inspection,
      rejectedCrossOriginJobs,
      trustedJobOrigins: [...trustedSourceOrigins(source)],
    },
    jobs: valid.map((raw) => makeJob(source, raw, observedAt, strategy)),
  };
}

export function dedupeJobs(jobs) {
  const externalGroups = new Map();
  for (const job of jobs) {
    if (job.externalId === null || job.externalId === undefined || job.externalId === "") continue;
    const key = `${job.sourceId}\0${job.externalId}`;
    const group = externalGroups.get(key) || [];
    group.push(job);
    externalGroups.set(key, group);
  }
  const conflictKeys = new Set();
  const identityConflicts = [];
  for (const [key, group] of externalGroups) {
    const urls = new Set(group.map((job) => canonicalizeUrl(job.applyUrl)).filter(Boolean));
    const identities = new Set(group.map((job) => `${normalizedJobText(job.company)}|${normalizedJobText(job.title)}`));
    if (urls.size <= 1 || identities.size <= 1) continue;
    conflictKeys.add(key);
    identityConflicts.push({
      sourceId: group[0].sourceId,
      externalId: String(group[0].externalId),
      jobIds: group.slice(0, 20).map((job) => job.id),
      applyUrls: [...urls].slice(0, 20),
      action: "blocked_identity_conflict_needs_review",
    });
  }
  const safeJobs = jobs.filter((job) => !conflictKeys.has(`${job.sourceId}\0${job.externalId}`));
  const unique = [];
  const exactDuplicates = [];
  const externalIndex = new Map();
  const urlIdentityIndexes = new Map();
  for (const job of safeJobs) {
    const externalKey = job.externalId === null || job.externalId === undefined || job.externalId === ""
      ? null
      : `${job.sourceId}\0${job.externalId}`;
    const applyUrl = canonicalizeUrl(job.applyUrl);
    const urlIdentityKey = applyUrl && job.urlIdentity !== "source_fallback"
      ? `${applyUrl}\0${softJobIdentity(job)}`
      : null;
    const candidates = new Set([
      externalKey === null ? undefined : externalIndex.get(externalKey),
      ...(urlIdentityKey ? urlIdentityIndexes.get(urlIdentityKey) || [] : []),
    ].filter((value) => Number.isInteger(value)));
    const existingIndex = [...candidates].find((index) => jobsCanExactMerge(unique[index], job)) ?? -1;
    if (existingIndex < 0) {
      const index = unique.push(job) - 1;
      if (externalKey) externalIndex.set(externalKey, index);
      if (urlIdentityKey) {
        const indexes = urlIdentityIndexes.get(urlIdentityKey) || [];
        indexes.push(index);
        urlIdentityIndexes.set(urlIdentityKey, indexes);
      }
      continue;
    }
    const existing = unique[existingIndex];
    const key = exactJobMergeKey(existing, job);
    const winner = (job.authenticityScore || 0) > (existing.authenticityScore || 0) ? job : existing;
    const loser = winner === job ? existing : job;
    winner.evidence = [...(winner.evidence || []), ...(loser.evidence || [])];
    unique[existingIndex] = winner;
    exactDuplicates.push({ key, kept: winner.id, merged: loser.id });
  }
  const softGroups = new Map();
  for (const job of unique) {
    const key = softJobIdentity(job);
    const group = softGroups.get(key) || [];
    group.push(job.id);
    softGroups.set(key, group);
  }
  const duplicateCandidates = [...softGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, jobIds: ids, action: "review_only_not_auto_merged" }));
  return {
    jobs: unique,
    exactDuplicates,
    duplicateCandidates,
    identityConflicts,
    stats: {
      input: jobs.length,
      output: unique.length,
      exactMerged: exactDuplicates.length,
      identityConflicts: identityConflicts.length,
      softReviewCandidates: duplicateCandidates.length,
    },
  };
}
