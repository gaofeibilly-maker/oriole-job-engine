import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EMPLOYER_UNIVERSE_SCHEMA_VERSION = "huangque.employer-universe.v1";
export const EMPLOYER_UNIVERSE_MINIMUM_TARGETS = 5_000;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultUniversePath = resolve(projectRoot, "data/huangque/employer-universe.json");
const defaultPriorityInventoryPath = resolve(projectRoot, "data/huangque/source-channel-plan.json");
const CURATED_SOURCE_ID = "curated-priority-employers";

const SOURCE_DEFINITIONS = Object.freeze({
  "sse-main-a": Object.freeze({
    id: "sse-main-a",
    authority: "official_exchange",
    label: "上海证券交易所 A 股主板公司",
    endpoint: "https://query.sse.com.cn/sseQuery/commonQuery.do?isPagination=true&sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L&type=inParams&CSRC_CODE=&STOCK_CODE=&REG_PROVINCE=&STOCK_TYPE=1&COMPANY_STATUS=2%2C4%2C5%2C7%2C8&pageHelp.cacheSize=1&pageHelp.beginPage=1&pageHelp.pageSize=4000&pageHelp.pageNo=1&pageHelp.endPage=1",
    evidenceUrl: "https://www.sse.com.cn/assortment/stock/list/share/",
    hostname: "query.sse.com.cn",
    pathname: "/sseQuery/commonQuery.do",
    minimumRecords: 1_600,
    maximumRecords: 2_500,
  }),
  "sse-star-a": Object.freeze({
    id: "sse-star-a",
    authority: "official_exchange",
    label: "上海证券交易所科创板公司",
    endpoint: "https://query.sse.com.cn/sseQuery/commonQuery.do?isPagination=true&sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L&type=inParams&CSRC_CODE=&STOCK_CODE=&REG_PROVINCE=&STOCK_TYPE=8&COMPANY_STATUS=2%2C4%2C5%2C7%2C8&pageHelp.cacheSize=1&pageHelp.beginPage=1&pageHelp.pageSize=4000&pageHelp.pageNo=1&pageHelp.endPage=1",
    evidenceUrl: "https://www.sse.com.cn/assortment/stock/list/share/",
    hostname: "query.sse.com.cn",
    pathname: "/sseQuery/commonQuery.do",
    // The official endpoint's active-company count has varied materially with
    // status filters. 350 is a conservative truncation guard, not a forecast.
    minimumRecords: 350,
    maximumRecords: 1_200,
  }),
  "szse-a": Object.freeze({
    id: "szse-a",
    authority: "official_exchange",
    label: "深交所法定信息披露平台巨潮资讯深市 A 股发布者",
    endpoint: "https://www.cninfo.com.cn/new/data/szse_stock.json",
    evidenceUrl: "https://www.cninfo.com.cn/new/snapshot/companyListCn",
    hostname: "www.cninfo.com.cn",
    pathname: "/new/data/szse_stock.json",
    minimumRecords: 2_800,
    maximumRecords: 3_500,
  }),
  "sasac-central-enterprises": Object.freeze({
    id: "sasac-central-enterprises",
    authority: "official_government_directory",
    label: "国务院国资委央企名录",
    endpoint: "https://www.sasac.gov.cn/n2588045/n27271785/n27271792/c14159097/content.html",
    evidenceUrl: "https://www.sasac.gov.cn/n2588045/n27271785/n27271792/c14159097/content.html",
    hostname: "www.sasac.gov.cn",
    pathname: "/n2588045/n27271785/n27271792/c14159097/content.html",
    minimumRecords: 90,
    maximumRecords: 150,
  }),
  [CURATED_SOURCE_ID]: Object.freeze({
    id: CURATED_SOURCE_ID,
    authority: "reviewed_curated_inventory",
    label: "人工审核优先用人单位",
    endpoint: "data/huangque/source-channel-plan.json",
    evidenceUrl: "data/huangque/source-channel-plan.json",
    minimumRecords: 19,
    maximumRecords: 19,
  }),
});

const REQUIRED_SOURCE_IDS = Object.freeze(Object.keys(SOURCE_DEFINITIONS));
const OFFICIAL_DIRECTORY_SOURCE_IDS = Object.freeze(REQUIRED_SOURCE_IDS.filter((id) => id !== CURATED_SOURCE_ID));

// Versioned fallback for the official SASAC directory. It is deliberately
// labelled snapshot when used; a failed live request can never be represented
// as a successful live observation. Source: SASAC "央企名录", 2026-07-11.
const SASAC_SNAPSHOT = Object.freeze({
  asOf: "2026-07-11",
  names: Object.freeze([
    "中国核工业集团有限公司",
    "中国航天科技集团有限公司",
    "中国航天科工集团有限公司",
    "中国航空工业集团有限公司",
    "中国船舶集团有限公司",
    "中国兵器工业集团有限公司",
    "中国兵器装备集团有限公司",
    "中国电子科技集团有限公司",
    "中国航空发动机集团有限公司",
    "中国融通资产管理集团有限公司",
    "中国石油天然气集团有限公司",
    "中国石油化工集团有限公司",
    "中国海洋石油集团有限公司",
    "国家石油天然气管网集团有限公司",
    "国家电网有限公司",
    "中国南方电网有限责任公司",
    "中国华能集团有限公司",
    "中国大唐集团有限公司",
    "中国华电集团有限公司",
    "国家电力投资集团有限公司",
    "中国长江三峡集团有限公司",
    "中国雅江集团有限公司",
    "国家能源投资集团有限责任公司",
    "中国电信集团有限公司",
    "中国联合网络通信集团有限公司",
    "中国移动通信集团有限公司",
    "中国卫星网络集团有限公司",
    "中国电子信息产业集团有限公司",
    "中国第一汽车集团有限公司",
    "东风汽车集团有限公司",
    "中国一重集团有限公司",
    "中国机械工业集团有限公司",
    "哈尔滨电气集团有限公司",
    "中国东方电气集团有限公司",
    "鞍钢集团有限公司",
    "中国宝武钢铁集团有限公司",
    "中国矿产资源集团有限公司",
    "中国铝业集团有限公司",
    "中国远洋海运集团有限公司",
    "中国航空集团有限公司",
    "中国东方航空集团有限公司",
    "中国南方航空集团有限公司",
    "中国中化控股有限责任公司",
    "中粮集团有限公司",
    "中国五矿集团有限公司",
    "中国通用技术（集团）控股有限责任公司",
    "中国建筑集团有限公司",
    "中国储备粮管理集团有限公司",
    "中国南水北调集团有限公司",
    "国家开发投资集团有限公司",
    "招商局集团有限公司",
    "华润（集团）有限公司",
    "中国旅游集团有限公司[香港中旅（集团）有限公司]",
    "中国商用飞机有限责任公司",
    "中国节能环保集团有限公司",
    "中国国际工程咨询有限公司",
    "中国诚通控股集团有限公司",
    "中国中煤能源集团有限公司",
    "中国煤炭科工集团有限公司",
    "中国机械科学研究总院集团有限公司",
    "中国钢研科技集团有限公司",
    "中国化学工程集团有限公司",
    "中国盐业集团有限公司",
    "中国建材集团有限公司",
    "中国有色矿业集团有限公司",
    "中国稀土集团有限公司",
    "中国资源循环集团有限公司",
    "中国有研科技集团有限公司",
    "矿冶科技集团有限公司",
    "中国国际技术智力合作集团有限公司",
    "中国建筑科学研究院有限公司",
    "中国中车集团有限公司",
    "中国长安汽车集团有限公司",
    "中国铁路通信信号集团有限公司",
    "中国铁路工程集团有限公司",
    "中国铁道建筑集团有限公司",
    "中国交通建设集团有限公司",
    "中国信息通信科技集团有限公司",
    "中国农业发展集团有限公司",
    "中国林业集团有限公司",
    "中国医药集团有限公司",
    "中国保利集团有限公司",
    "中国建设科技有限公司",
    "中国冶金地质总局",
    "中国煤炭地质总局",
    "新兴际华集团有限公司",
    "中国民航信息集团有限公司",
    "中国航空器材集团有限公司",
    "中国电力建设集团有限公司",
    "中国能源建设集团有限公司",
    "中国安能建设集团有限公司",
    "中国黄金集团有限公司",
    "中国广核集团有限公司",
    "华侨城集团有限公司",
    "南光（集团）有限公司[中国南光集团有限公司]",
    "中国电气装备集团有限公司",
    "中国物流集团有限公司",
    "中国国新控股有限责任公司",
    "中国检验认证（集团）有限公司",
  ]),
});

const REQUIRED_CURATED_IDS = Object.freeze([
  "bytedance", "tencent", "alibaba", "meituan", "baidu", "jd", "huawei", "xiaomi", "dji", "lenovo",
  "zte", "byd", "catl", "midea", "haier", "state_grid", "china_mobile", "cnpc", "sinopec",
]);

// Only unambiguous legal-name bridges are allowed. China Mobile/CNPC/Sinopec
// each have both a listed issuer and a distinct SASAC group parent, so their
// reviewed brand target must not silently collapse those two legal entities.
const CURATED_LEGAL_NAME_ALIASES = Object.freeze({
  state_grid: Object.freeze(["国家电网有限公司"]),
});

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("时间必须是有效日期");
  return date.toISOString();
}

function safeError(error) {
  return {
    code: String(error?.code || "FETCH_OR_PARSE_FAILED").slice(0, 100),
    message: String(error?.message || error || "未知错误").replace(/[\r\n]+/g, " ").slice(0, 500),
  };
}

function officialUrl(value, { hostname = null, pathname = null } = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError(`官方来源 URL 无效：${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new TypeError(`官方来源必须使用无凭据 HTTPS URL：${value}`);
  }
  if (hostname && url.hostname !== hostname) throw new TypeError(`官方来源 host 不在固定边界：${url.hostname}`);
  if (pathname && url.pathname !== pathname) throw new TypeError(`官方来源 path 不在固定边界：${url.pathname}`);
  return url;
}

for (const source of OFFICIAL_DIRECTORY_SOURCE_IDS.map((id) => SOURCE_DEFINITIONS[id])) {
  officialUrl(source.endpoint, source);
  officialUrl(source.evidenceUrl);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

async function fetchTextOnce(url, {
  fetchImpl,
  timeoutMs,
  headers,
  expectedContentType,
  maximumBytes,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("refreshEmployerUniverse 需要 fetch 实现");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("官方目录请求超时")), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw Object.assign(new Error(`官方目录请求超时：${new URL(url).hostname}`), { code: "DIRECTORY_TIMEOUT" });
    }
    throw Object.assign(new Error(`官方目录请求失败：${new URL(url).hostname}：${error.message}`), { code: "DIRECTORY_FETCH_FAILED" });
  } finally {
    clearTimeout(timeout);
  }
  if (!response || typeof response.text !== "function" || typeof response.status !== "number") {
    throw Object.assign(new TypeError("fetch 返回值不符合 Response 接口"), { code: "INVALID_FETCH_RESPONSE" });
  }
  if (response.status !== 200 || response.ok !== true) {
    throw Object.assign(new Error(`官方目录 ${new URL(url).hostname} 返回 HTTP ${response.status}`), { code: "DIRECTORY_HTTP_ERROR", status: response.status });
  }
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw Object.assign(new Error(`官方目录响应超过 ${maximumBytes} 字节上限`), { code: "DIRECTORY_RESPONSE_TOO_LARGE" });
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (expectedContentType && !expectedContentType.test(contentType)) {
    throw Object.assign(new Error(`官方目录 Content-Type 不符合预期：${contentType || "missing"}`), { code: "DIRECTORY_CONTENT_TYPE_INVALID" });
  }
  const text = await response.text();
  if (byteLength(text) > maximumBytes) {
    throw Object.assign(new Error(`官方目录正文超过 ${maximumBytes} 字节上限`), { code: "DIRECTORY_RESPONSE_TOO_LARGE" });
  }
  return text;
}

function isTransientDirectoryError(error) {
  return ["DIRECTORY_FETCH_FAILED", "DIRECTORY_TIMEOUT"].includes(error?.code)
    || (error?.code === "DIRECTORY_HTTP_ERROR" && (error.status === 429 || error.status >= 500));
}

async function fetchText(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchTextOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isTransientDirectoryError(error)) throw error;
      // Official exchange endpoints occasionally return an isolated 5xx under
      // pagination load. A small bounded backoff makes the daily run resilient
      // without weakening content, count or completeness validation.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
    }
  }
  throw lastError;
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw Object.assign(new Error(`${label} 返回无效 JSON：${error.message}`), { code: "DIRECTORY_JSON_INVALID" }); }
}

function cleanText(value, maximum = 300) {
  const output = String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (!output || output.length > maximum || /[<>]/.test(output)) return null;
  return output;
}

function cleanListedName(value) {
  const text = cleanText(value, 160);
  if (!text) return null;
  return text
    .replace(/^S?\*?ST\s*/i, "")
    .replace(/\s+/g, /[\p{Script=Han}]/u.test(text) ? "" : " ")
    .trim() || null;
}

function canonicalName(value) {
  const text = cleanText(value, 300);
  if (!text) return null;
  return text
    .replace(/^S?\*?ST/i, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function stableEmployerId(name) {
  const canonical = canonicalName(name);
  if (!canonical || canonical.length < 2) throw new TypeError(`企业名称无法形成稳定 ID：${name}`);
  return `employer-cn-${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}`;
}

function normalizedDate(value) {
  const text = String(value || "").trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function baseTarget(name, {
  tier,
  kind,
  industry = null,
  regionCode = null,
  officialWebsite = null,
  officialRecruitmentUrl = null,
  officialDomains = [],
  evidence,
  aliases = [],
  identifiers = [],
}) {
  const cleanedName = cleanText(name, 300);
  if (!cleanedName) throw new TypeError("官方目录企业名称为空或不安全");
  return {
    id: stableEmployerId(cleanedName),
    name: cleanedName,
    tier,
    kind,
    industry: cleanText(industry, 200),
    regionCode: /^\d{6}$/.test(String(regionCode || "")) ? String(regionCode) : null,
    officialWebsite,
    officialRecruitmentUrl,
    officialDomains: [...new Set(officialDomains)].sort(),
    aliases: [...new Set(aliases.map((value) => cleanText(value, 300)).filter(Boolean))].sort(),
    identifiers,
    evidence: [evidence],
  };
}

function sourceEvidence(source, observedAt, sourceMode, details) {
  return {
    sourceId: source.id,
    sourceMode,
    authority: source.authority,
    url: source.evidenceUrl,
    observedAt,
    ...details,
  };
}

function assertRecordCount(source, count) {
  if (!Number.isSafeInteger(count) || count < source.minimumRecords || count > source.maximumRecords) {
    throw Object.assign(new Error(`${source.label}记录数 ${count} 不在可信区间 ${source.minimumRecords}-${source.maximumRecords}`), {
      code: "DIRECTORY_RECORD_COUNT_OUT_OF_RANGE",
      sourceId: source.id,
      count,
    });
  }
}

function parseSsePayload(text, source, stockType, observedAt) {
  const payload = parseJson(text, source.label);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError(`${source.label}顶层必须是对象`);
  if (payload.sqlId !== "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L") throw new TypeError(`${source.label} sqlId 不匹配`);
  if (Array.isArray(payload.actionErrors) && payload.actionErrors.length) throw new TypeError(`${source.label}返回 actionErrors`);
  const page = payload.pageHelp;
  if (!page || !Array.isArray(page.data)) throw new TypeError(`${source.label}缺少 pageHelp.data[]`);
  const total = Number(page.total);
  if (!Number.isSafeInteger(total) || total !== page.data.length || Number(page.pageCount) !== 1 || Number(page.pageNo) !== 1) {
    throw new TypeError(`${source.label}分页不完整或记录总数不一致`);
  }
  assertRecordCount(source, total);
  const seenCodes = new Set();
  const targets = page.data.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError(`${source.label}第 ${index + 1} 行不是对象`);
    const code = String(row.A_STOCK_CODE || "").trim();
    const name = cleanText(row.FULL_NAME, 300);
    const shortName = cleanListedName(row.COMPANY_ABBR || row.SEC_NAME_CN);
    if (!/^\d{6}$/.test(code) || !name || !shortName || String(row.STOCK_TYPE) !== stockType) {
      throw new TypeError(`${source.label}第 ${index + 1} 行缺少有效代码、名称或板块`);
    }
    if (seenCodes.has(code)) throw new TypeError(`${source.label}股票代码重复：${code}`);
    seenCodes.add(code);
    return baseTarget(name, {
      tier: "B",
      kind: "listed_company",
      industry: row.CSRC_CODE_DESC,
      regionCode: row.AREA_NAME,
      aliases: [shortName],
      identifiers: [{ scheme: "cn_stock_code", value: code, exchange: "SSE" }],
      evidence: sourceEvidence(source, observedAt, "live", {
        externalId: code,
        exchange: "SSE",
        board: stockType === "8" ? "STAR" : "MAIN",
        listingDate: normalizedDate(row.LIST_DATE),
      }),
    });
  });
  return {
    targets,
    source: {
      id: source.id,
      label: source.label,
      authority: source.authority,
      mode: "live",
      endpoint: source.endpoint,
      evidenceUrl: source.evidenceUrl,
      observedAt,
      sourceDate: normalizedDate(payload.queryDate),
      records: targets.length,
      minimumRecords: source.minimumRecords,
      maximumRecords: source.maximumRecords,
    },
  };
}

async function fetchSzse({ fetchImpl, timeoutMs, observedAt }) {
  const source = SOURCE_DEFINITIONS["szse-a"];
  const text = await fetchText(source.endpoint, {
    fetchImpl,
    timeoutMs,
    headers: { accept: "application/json", referer: "https://www.cninfo.com.cn/", "user-agent": "Oriole-Employer-Universe/2.0" },
    expectedContentType: /(?:application|text)\/json/,
    maximumBytes: 3_000_000,
  });
  const payload = parseJson(text, source.label);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.stockList) || payload.stockList.length < 5_000 || payload.stockList.length > 8_000) {
    throw new TypeError(`${source.label}顶层结构或全市场 stockList[] 数量无效`);
  }
  for (const [index, row] of payload.stockList.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !/^\d{6}$/.test(String(row.code || ""))
      || !["A股", "B股", "CDR"].includes(row.category)
      || !cleanListedName(row.zwjc)
      || !String(row.orgId || "").trim()) {
      throw new TypeError(`${source.label}全市场目录第 ${index + 1} 行结构无效`);
    }
  }
  // The legal-disclosure publisher file contains all markets and preserves
  // historical issuers. Bound it to Shenzhen A-share code families, excluding
  // entries whose official short name explicitly ends in “退/退市”. Remaining
  // historical publishers are intentionally retained as employer leads.
  const rows = payload.stockList.filter((row) => row.category === "A股"
    && /^(?:000|001|002|003|300|301|302)\d{3}$/.test(row.code)
    && !/退(?:市)?$/.test(cleanListedName(row.zwjc)));
  assertRecordCount(source, rows.length);
  const seenCodes = new Set();
  const targets = rows.map((row, index) => {
    const code = String(row.code).trim();
    const name = cleanListedName(row.zwjc);
    if (seenCodes.has(code)) throw new TypeError(`${source.label}股票代码重复：${code}`);
    seenCodes.add(code);
    const board = /^30/.test(code) ? "CHINEXT" : "MAIN";
    return baseTarget(name, {
      tier: "B",
      kind: "listed_company",
      identifiers: [
        { scheme: "cn_stock_code", value: code, exchange: "SZSE" },
        { scheme: "cninfo_org_id", value: String(row.orgId) },
      ],
      evidence: sourceEvidence(source, observedAt, "live", {
        externalId: code,
        exchange: "SZSE",
        board,
        directoryScope: "current_and_historical_publishers_excluding_explicit_delisted_names",
      }),
    });
  });
  return {
    targets,
    source: {
      id: source.id,
      label: source.label,
      authority: source.authority,
      mode: "live",
      endpoint: source.endpoint,
      evidenceUrl: source.evidenceUrl,
      observedAt,
      sourceDate: null,
      records: targets.length,
      minimumRecords: source.minimumRecords,
      maximumRecords: source.maximumRecords,
      directoryScope: "current_and_historical_publishers_excluding_explicit_delisted_names",
    },
  };
}

function htmlText(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:a|div|li|p|td|th|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .normalize("NFKC");
}

function parseSasacHtml(text) {
  const plain = htmlText(text);
  const publishedAt = plain.match(/发布时间\s*[:：]?\s*(20\d{2}-\d{2}-\d{2})/)?.[1] || null;
  const names = [];
  const seen = new Set();
  const pattern = /(?:^|\s)(?:\d{1,3}[.、]?\s*)?([\p{Script=Han}A-Za-z0-9（）()·—－\[\]]{2,160}?(?:集团有限公司|控股有限责任公司|有限责任公司|有限公司|总局)(?:\[[^\]\n]{2,100}\])?)(?=\s|$)/gu;
  for (const match of plain.matchAll(pattern)) {
    const name = cleanText(match[1], 300);
    const key = canonicalName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return { names, sourceDate: publishedAt };
}

function sasacTargets(names, sourceMode, observedAt) {
  const source = SOURCE_DEFINITIONS["sasac-central-enterprises"];
  assertRecordCount(source, names.length);
  return names.map((name, index) => baseTarget(name, {
    tier: "A",
    kind: "central_state_owned_parent",
    identifiers: [{ scheme: "sasac_directory_ordinal", value: String(index + 1) }],
    evidence: sourceEvidence(source, observedAt, sourceMode, {
      externalId: `sasac-${String(index + 1).padStart(3, "0")}`,
      directoryAsOf: sourceMode === "snapshot" ? SASAC_SNAPSHOT.asOf : null,
    }),
  }));
}

async function fetchSasac({ fetchImpl, timeoutMs, observedAt, allowSnapshotFallback }) {
  const source = SOURCE_DEFINITIONS["sasac-central-enterprises"];
  try {
    const text = await fetchText(source.endpoint, {
      fetchImpl,
      timeoutMs,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Oriole-Employer-Universe/2.0" },
      expectedContentType: /text\/html|application\/xhtml\+xml/,
      maximumBytes: 5_000_000,
    });
    const parsed = parseSasacHtml(text);
    const targets = sasacTargets(parsed.names, "live", observedAt);
    return {
      targets,
      source: {
        id: source.id,
        label: source.label,
        authority: source.authority,
        mode: "live",
        endpoint: source.endpoint,
        evidenceUrl: source.evidenceUrl,
        observedAt,
        sourceDate: parsed.sourceDate,
        records: targets.length,
        minimumRecords: source.minimumRecords,
        maximumRecords: source.maximumRecords,
      },
    };
  } catch (error) {
    if (!allowSnapshotFallback) throw error;
    const targets = sasacTargets(SASAC_SNAPSHOT.names, "snapshot", observedAt);
    return {
      targets,
      source: {
        id: source.id,
        label: source.label,
        authority: source.authority,
        mode: "snapshot",
        endpoint: source.endpoint,
        evidenceUrl: source.evidenceUrl,
        observedAt,
        sourceDate: SASAC_SNAPSHOT.asOf,
        snapshotAsOf: SASAC_SNAPSHOT.asOf,
        records: targets.length,
        minimumRecords: source.minimumRecords,
        maximumRecords: source.maximumRecords,
        liveAttempt: { status: "failed", ...safeError(error) },
      },
    };
  }
}

async function loadCuratedPriorityTargets({ inventoryPath, observedAt }) {
  const source = SOURCE_DEFINITIONS[CURATED_SOURCE_ID];
  let payload;
  try {
    payload = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`无法读取版本化人工审核优先目标：${error.message}`), {
      code: "CURATED_INVENTORY_INVALID",
    });
  }
  const inventory = payload?.targetInventory;
  const employers = inventory?.employers;
  const inventoryVersion = String(payload?.metadata?.version || "");
  const reviewedAt = payload?.metadata?.reviewedAt;
  if (payload?.schemaVersion !== "huangque.source-channel-plan.v1"
    || !/^20\d{2}-\d{2}-\d{2}$/.test(inventoryVersion)
    || asIso(reviewedAt) !== reviewedAt
    || inventory?.reviewedAt !== reviewedAt
    || !Array.isArray(employers)
    || employers.length !== source.minimumRecords) {
    throw Object.assign(new TypeError("版本化人工审核优先目标的结构、版本或数量无效"), { code: "CURATED_INVENTORY_INVALID" });
  }
  const ids = employers.map((employer) => employer?.id);
  if (new Set(ids).size !== REQUIRED_CURATED_IDS.length
    || REQUIRED_CURATED_IDS.some((id) => !ids.includes(id))) {
    throw Object.assign(new TypeError("人工审核优先目标必须包含固定的 19 家用人单位"), { code: "CURATED_INVENTORY_INVALID" });
  }
  const targets = employers.map((employer) => {
    const curatedId = String(employer.id || "");
    const name = cleanText(employer.name, 300);
    const aliases = employer.match?.publisherAliases;
    const domains = employer.match?.hosts;
    const recruitmentUrl = employer.audit?.officialRecruitmentUrl;
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(curatedId) || !name
      || !Array.isArray(aliases) || aliases.length < 1
      || !Array.isArray(domains) || domains.length < 1
      || employer.audit?.evidenceKind !== "official_recruitment_root") {
      throw Object.assign(new TypeError(`人工审核优先目标 ${curatedId || "unknown"} 字段不完整`), { code: "CURATED_INVENTORY_INVALID" });
    }
    const root = officialUrl(recruitmentUrl).toString();
    const normalizedDomains = [...new Set(domains.map((domain) => String(domain).toLowerCase()))].sort();
    for (const domain of normalizedDomains) {
      if (officialUrl(`https://${domain}/`).hostname !== domain) {
        throw Object.assign(new TypeError(`人工审核优先目标 ${curatedId} 域名无效`), { code: "CURATED_INVENTORY_INVALID" });
      }
    }
    if (!normalizedDomains.includes(new URL(root).hostname)) {
      throw Object.assign(new TypeError(`人工审核优先目标 ${curatedId} 招聘网址不在审核域名边界内`), { code: "CURATED_INVENTORY_INVALID" });
    }
    return baseTarget(name, {
      tier: "A",
      kind: "reviewed_priority_employer",
      industry: cleanText(employer.segment, 100),
      officialRecruitmentUrl: root,
      officialDomains: normalizedDomains,
      aliases: [...aliases, ...(CURATED_LEGAL_NAME_ALIASES[curatedId] || [])],
      identifiers: [{ scheme: "curated_priority_id", value: `priority:${curatedId}` }],
      evidence: {
        sourceId: source.id,
        sourceMode: "curated_snapshot",
        authority: source.authority,
        url: root,
        observedAt,
        externalId: `priority:${curatedId}`,
        inventoryPath: source.endpoint,
        inventoryVersion,
        reviewedAt,
        evidenceKind: employer.audit.evidenceKind,
      },
    });
  });
  assertRecordCount(source, targets.length);
  return {
    targets,
    source: {
      id: source.id,
      label: source.label,
      authority: source.authority,
      mode: "curated_snapshot",
      endpoint: source.endpoint,
      evidenceUrl: source.evidenceUrl,
      observedAt,
      sourceDate: reviewedAt.slice(0, 10),
      snapshotAsOf: inventoryVersion,
      inventoryVersion,
      records: targets.length,
      minimumRecords: source.minimumRecords,
      maximumRecords: source.maximumRecords,
    },
  };
}

function mergeTargets(rawTargets) {
  const records = new Map();
  const keyToRecord = new Map();
  let mergedDuplicates = 0;
  for (const target of rawTargets) {
    const matchKeys = [...new Set([target.name, ...target.aliases].map(canonicalName).filter(Boolean))];
    if (matchKeys.length === 0) throw new TypeError("企业名称无法归一化");
    const matchedRecords = [...new Set(matchKeys.map((key) => keyToRecord.get(key)).filter(Boolean))];
    if (matchedRecords.length > 1) throw new TypeError(`企业别名把多个目标错误桥接：${target.name}`);
    const recordKey = matchedRecords[0] || canonicalName(target.name);
    const current = records.get(recordKey);
    if (!current) {
      const cloned = structuredClone(target);
      records.set(recordKey, cloned);
      for (const key of matchKeys) keyToRecord.set(key, recordKey);
      continue;
    }
    mergedDuplicates += 1;
    const tier = current.tier === "A" || target.tier === "A" ? "A" : "B";
    const prefer = current.kind === "central_state_owned_parent" ? current
      : target.kind === "central_state_owned_parent" ? target
        : target.kind === "reviewed_priority_employer" && current.kind !== "reviewed_priority_employer" ? target
          : target.tier === "A" && current.tier !== "A" ? target : current;
    current.name = prefer.name;
    current.id = stableEmployerId(prefer.name);
    current.tier = tier;
    current.kind = current.kind === "central_state_owned_parent" || target.kind === "central_state_owned_parent"
      ? "central_state_owned_parent"
      : current.kind === "reviewed_priority_employer" || target.kind === "reviewed_priority_employer"
        ? "reviewed_priority_employer" : "listed_company";
    current.industry ||= target.industry;
    current.regionCode ||= target.regionCode;
    current.officialWebsite ||= target.officialWebsite;
    current.officialRecruitmentUrl ||= target.officialRecruitmentUrl;
    current.officialDomains = [...new Set([...current.officialDomains, ...target.officialDomains])].sort();
    current.aliases = [...new Set([...current.aliases, ...target.aliases, current.name, target.name])].filter((value) => value !== current.name).sort();
    current.identifiers = [...new Map([...current.identifiers, ...target.identifiers].map((value) => [`${value.scheme}:${value.exchange || ""}:${value.value}`, value])).values()]
      .sort((left, right) => `${left.scheme}:${left.exchange || ""}:${left.value}`.localeCompare(`${right.scheme}:${right.exchange || ""}:${right.value}`));
    current.evidence = [...new Map([...current.evidence, ...target.evidence].map((value) => [`${value.sourceId}:${value.externalId}`, value])).values()]
      .sort((left, right) => `${left.sourceId}:${left.externalId}`.localeCompare(`${right.sourceId}:${right.externalId}`));
    for (const key of [...matchKeys, ...current.aliases.map(canonicalName), canonicalName(current.name)].filter(Boolean)) {
      keyToRecord.set(key, recordKey);
    }
  }
  const targets = [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
  const seenIds = new Map();
  for (const target of targets) {
    const prior = seenIds.get(target.id);
    if (prior && canonicalName(prior) !== canonicalName(target.name)) throw new TypeError(`稳定企业 ID 哈希冲突：${target.id}`);
    seenIds.set(target.id, target.name);
  }
  return { targets, mergedDuplicates };
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value) || "unknown";
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function buildPayload(results, generatedAt) {
  const sources = results.map((result) => result.source).sort((left, right) => left.id.localeCompare(right.id));
  const rawTargets = results.flatMap((result) => result.targets);
  const { targets, mergedDuplicates } = mergeTargets(rawTargets);
  const sourceRecords = Object.fromEntries(sources.map((source) => [source.id, source.records]));
  const dataModes = [...new Set(sources.map((source) => source.mode))].sort();
  return {
    schemaVersion: EMPLOYER_UNIVERSE_SCHEMA_VERSION,
    metadata: {
      project: "黄雀 Oriole",
      scope: "全国重点用人单位第一阶段",
      generatedAt,
      minimumTargets: EMPLOYER_UNIVERSE_MINIMUM_TARGETS,
      complete: true,
      completeness: "bounded_official_directory_universe",
      definition: "以上交所 A 股主板和科创板、深交所 A 股及国务院国资委央企名录为有界分母，并合并版本化人工审核优先企业；用于驱动招聘官网寻源，不代表覆盖全部中国用人单位。",
      allSourcesLive: sources.every((source) => source.mode === "live"),
      allOfficialSourcesLive: sources
        .filter((source) => OFFICIAL_DIRECTORY_SOURCE_IDS.includes(source.id))
        .every((source) => source.mode === "live"),
      dataModes,
    },
    sources,
    stats: {
      totalTargets: targets.length,
      rawRecords: rawTargets.length,
      mergedDuplicates,
      sourceRecords,
      targetsByTier: countBy(targets, (target) => target.tier),
      targetsByKind: countBy(targets, (target) => target.kind),
      liveSourceRecords: sources.filter((source) => source.mode === "live").reduce((sum, source) => sum + source.records, 0),
      snapshotSourceRecords: sources.filter((source) => source.mode === "snapshot").reduce((sum, source) => sum + source.records, 0),
      curatedSourceRecords: sources.filter((source) => source.mode === "curated_snapshot").reduce((sum, source) => sum + source.records, 0),
    },
    targets,
  };
}

function nullableString(value, label) {
  if (value !== null && (typeof value !== "string" || !value.trim())) throw new TypeError(`${label} 必须是非空字符串或 null`);
}

export function validateEmployerUniverse(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("用人单位目标库必须是对象");
  if (payload.schemaVersion !== EMPLOYER_UNIVERSE_SCHEMA_VERSION) throw new TypeError(`目标库必须符合 ${EMPLOYER_UNIVERSE_SCHEMA_VERSION}`);
  if (!payload.metadata || asIso(payload.metadata.generatedAt) !== payload.metadata.generatedAt) throw new TypeError("目标库缺少规范 generatedAt");
  if (payload.metadata.minimumTargets !== EMPLOYER_UNIVERSE_MINIMUM_TARGETS
    || payload.metadata.complete !== true
    || payload.metadata.completeness !== "bounded_official_directory_universe"
    || !payload.metadata.definition) throw new TypeError("目标库缺少准确的有界覆盖声明");
  if (!Array.isArray(payload.sources) || payload.sources.length !== REQUIRED_SOURCE_IDS.length) throw new TypeError("目标库必须包含四个固定官方目录和一份版本化优先清单");
  if (!Array.isArray(payload.targets) || payload.targets.length < EMPLOYER_UNIVERSE_MINIMUM_TARGETS) {
    throw new TypeError(`目标库至少需要 ${EMPLOYER_UNIVERSE_MINIMUM_TARGETS} 个去重用人单位`);
  }
  const sourceIds = payload.sources.map((source) => source?.id);
  if (new Set(sourceIds).size !== REQUIRED_SOURCE_IDS.length || REQUIRED_SOURCE_IDS.some((id) => !sourceIds.includes(id))) {
    throw new TypeError("目标库来源 ID 必须与四个固定官方目录和版本化优先清单完全一致");
  }
  const sourceById = new Map();
  for (const source of payload.sources) {
    const definition = SOURCE_DEFINITIONS[source.id];
    const validMode = source.id === CURATED_SOURCE_ID
      ? source.mode === "curated_snapshot"
      : source.id === "sasac-central-enterprises" ? ["live", "snapshot"].includes(source.mode) : source.mode === "live";
    if (!definition || source.endpoint !== definition.endpoint || source.evidenceUrl !== definition.evidenceUrl
      || source.authority !== definition.authority || !validMode) {
      throw new TypeError(`来源 ${source.id} 的固定端点、权威类型或模式无效`);
    }
    if (source.mode === "snapshot" && (!source.snapshotAsOf || source.liveAttempt?.status !== "failed")) {
      throw new TypeError("SASAC 快照必须记录 snapshotAsOf 和失败的 liveAttempt");
    }
    if (source.id === CURATED_SOURCE_ID && (!/^20\d{2}-\d{2}-\d{2}$/.test(source.inventoryVersion)
      || source.snapshotAsOf !== source.inventoryVersion)) {
      throw new TypeError("人工审核优先清单必须记录准确的版本和快照日期");
    }
    if (asIso(source.observedAt) !== source.observedAt) throw new TypeError(`来源 ${source.id} observedAt 无效`);
    if (source.minimumRecords !== definition.minimumRecords || source.maximumRecords !== definition.maximumRecords) throw new TypeError(`来源 ${source.id} 数量边界被修改`);
    assertRecordCount(definition, source.records);
    sourceById.set(source.id, source);
  }
  const dataModes = [...new Set(payload.sources.map((source) => source.mode))].sort();
  const officialSourcesLive = payload.sources
    .filter((source) => OFFICIAL_DIRECTORY_SOURCE_IDS.includes(source.id))
    .every((source) => source.mode === "live");
  if (JSON.stringify(payload.metadata.dataModes) !== JSON.stringify(dataModes)
    || payload.metadata.allSourcesLive !== dataModes.every((mode) => mode === "live")
    || payload.metadata.allOfficialSourcesLive !== officialSourcesLive) {
    throw new TypeError("目标库 live/snapshot 汇总与来源明细不一致");
  }
  const ids = new Set();
  const evidenceIdsBySource = new Map(payload.sources.map((source) => [source.id, new Set()]));
  let previousId = "";
  for (const [index, target] of payload.targets.entries()) {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new TypeError(`第 ${index + 1} 个目标不是对象`);
    if (!/^employer-cn-[a-f0-9]{20}$/.test(target.id) || target.id !== stableEmployerId(target.name)) throw new TypeError(`目标 ${target.id || index + 1} 稳定 ID 无效`);
    if (ids.has(target.id)) throw new TypeError(`目标 ID 重复：${target.id}`);
    if (target.id.localeCompare(previousId) < 0) throw new TypeError("目标必须按稳定 ID 排序");
    ids.add(target.id);
    previousId = target.id;
    if (!cleanText(target.name, 300) || !["A", "B", "C"].includes(target.tier)
      || !["listed_company", "central_state_owned_parent", "reviewed_priority_employer"].includes(target.kind)) {
      throw new TypeError(`目标 ${target.id} 缺少名称、等级或类型`);
    }
    nullableString(target.industry, `${target.id}.industry`);
    if (target.regionCode !== null && !/^\d{6}$/.test(target.regionCode)) throw new TypeError(`${target.id}.regionCode 无效`);
    nullableString(target.officialWebsite, `${target.id}.officialWebsite`);
    nullableString(target.officialRecruitmentUrl, `${target.id}.officialRecruitmentUrl`);
    for (const value of [target.officialWebsite, target.officialRecruitmentUrl].filter(Boolean)) officialUrl(value);
    if (!Array.isArray(target.officialDomains) || target.officialDomains.some((domain) => {
      const value = String(domain || "");
      try { return !value || value !== value.toLowerCase() || officialUrl(`https://${value}/`).hostname !== value; }
      catch { return true; }
    })) throw new TypeError(`${target.id}.officialDomains 无效`);
    if (target.officialRecruitmentUrl && !target.officialDomains.includes(new URL(target.officialRecruitmentUrl).hostname)) {
      throw new TypeError(`${target.id} 招聘网址不在 officialDomains 边界内`);
    }
    if (!Array.isArray(target.evidence) || target.evidence.length === 0) throw new TypeError(`目标 ${target.id} 缺少证据`);
    for (const evidence of target.evidence) {
      const source = sourceById.get(evidence?.sourceId);
      const curatedEvidenceValid = source?.id !== CURATED_SOURCE_ID
        || (evidence.url === target.officialRecruitmentUrl
          && evidence.inventoryPath === source.endpoint
          && evidence.inventoryVersion === source.inventoryVersion
          && evidence.reviewedAt === `${source.sourceDate}T00:00:00.000Z`
          && evidence.evidenceKind === "official_recruitment_root"
          && /^priority:[a-z][a-z0-9_]{1,60}$/.test(evidence.externalId));
      const officialEvidenceValid = source?.id === CURATED_SOURCE_ID || evidence.url === source?.evidenceUrl;
      if (!source || evidence.sourceMode !== source.mode || evidence.authority !== source.authority || !curatedEvidenceValid || !officialEvidenceValid
        || asIso(evidence.observedAt) !== evidence.observedAt || !String(evidence.externalId || "").trim()) {
        throw new TypeError(`目标 ${target.id} 包含无效或错标模式的证据`);
      }
      evidenceIdsBySource.get(source.id).add(evidence.externalId);
    }
  }
  for (const source of payload.sources) {
    if (evidenceIdsBySource.get(source.id).size !== source.records) throw new TypeError(`来源 ${source.id} 的证据记录不完整`);
  }
  const bytedance = payload.targets.find((target) => target.identifiers?.some((identifier) => identifier.scheme === "curated_priority_id"
    && identifier.value === "priority:bytedance"));
  if (!bytedance || bytedance.officialRecruitmentUrl !== "https://jobs.bytedance.com/"
    || !bytedance.officialDomains.includes("jobs.bytedance.com")) {
    throw new TypeError("版本化优先目标必须包含字节跳动官方招聘入口");
  }
  const expectedSourceRecords = Object.fromEntries(payload.sources.map((source) => [source.id, source.records]));
  const rawRecords = payload.sources.reduce((sum, source) => sum + source.records, 0);
  if (!payload.stats || payload.stats.totalTargets !== payload.targets.length || payload.stats.rawRecords !== rawRecords
    || payload.stats.mergedDuplicates !== rawRecords - payload.targets.length
    || JSON.stringify(payload.stats.sourceRecords) !== JSON.stringify(expectedSourceRecords)
    || JSON.stringify(payload.stats.targetsByTier) !== JSON.stringify(countBy(payload.targets, (target) => target.tier))
    || JSON.stringify(payload.stats.targetsByKind) !== JSON.stringify(countBy(payload.targets, (target) => target.kind))) {
    throw new TypeError("目标库统计与来源/目标明细不一致");
  }
  const liveRecords = payload.sources.filter((source) => source.mode === "live").reduce((sum, source) => sum + source.records, 0);
  const snapshotRecords = payload.sources.filter((source) => source.mode === "snapshot").reduce((sum, source) => sum + source.records, 0);
  const curatedRecords = payload.sources.filter((source) => source.mode === "curated_snapshot").reduce((sum, source) => sum + source.records, 0);
  if (payload.stats.liveSourceRecords !== liveRecords || payload.stats.snapshotSourceRecords !== snapshotRecords
    || payload.stats.curatedSourceRecords !== curatedRecords) throw new TypeError("目标库 live/snapshot/curated 记录数统计不一致");
  return payload;
}

export async function loadEmployerUniverse(path = defaultUniversePath) {
  let payload;
  try { payload = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`无法读取用人单位目标库 ${path}：${error.message}`); }
  return validateEmployerUniverse(payload);
}

async function atomicWriteJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function refreshEmployerUniverse({
  outputPath = defaultUniversePath,
  priorityInventoryPath = defaultPriorityInventoryPath,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  timeoutMs = 30_000,
  allowSasacSnapshotFallback = true,
} = {}) {
  const observedAt = asIso(typeof now === "function" ? now() : now);
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 120_000) throw new TypeError("timeoutMs 必须在 1000-120000 之间");

  // Build every source in memory first. A failure in SSE/SZSE or a disallowed
  // SASAC fallback throws before the existing complete snapshot is touched.
  const sseHeaders = { accept: "application/json", referer: "https://www.sse.com.cn/", "user-agent": "Oriole-Employer-Universe/2.0" };
  const [sseMainText, sseStarText] = await Promise.all([
    fetchText(SOURCE_DEFINITIONS["sse-main-a"].endpoint, {
      fetchImpl, timeoutMs: timeout, headers: sseHeaders, expectedContentType: /(?:application|text)\/json/, maximumBytes: 15_000_000,
    }),
    fetchText(SOURCE_DEFINITIONS["sse-star-a"].endpoint, {
      fetchImpl, timeoutMs: timeout, headers: sseHeaders, expectedContentType: /(?:application|text)\/json/, maximumBytes: 8_000_000,
    }),
  ]);
  const results = [
    parseSsePayload(sseMainText, SOURCE_DEFINITIONS["sse-main-a"], "1", observedAt),
    parseSsePayload(sseStarText, SOURCE_DEFINITIONS["sse-star-a"], "8", observedAt),
    await fetchSzse({ fetchImpl, timeoutMs: timeout, observedAt }),
    await fetchSasac({ fetchImpl, timeoutMs: timeout, observedAt, allowSnapshotFallback: allowSasacSnapshotFallback }),
    await loadCuratedPriorityTargets({ inventoryPath: resolve(priorityInventoryPath), observedAt }),
  ];
  const payload = validateEmployerUniverse(buildPayload(results, observedAt));
  if (outputPath !== null && outputPath !== false) await atomicWriteJson(resolve(outputPath), payload);
  return payload;
}
