import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { canonicalizeUrl, isPrivateOrLocalHost } from "./source-discovery.mjs";

export const HUANGQUE_USER_AGENT = "HuangqueJobSourceAgent/1.0 (+public-source-audit; respects robots.txt)";

export class NetworkSafetyError extends Error {
  constructor(message, code = "NETWORK_SAFETY_BLOCK") {
    super(message);
    this.name = "NetworkSafetyError";
    this.code = code;
  }
}

const LOCAL_CONTROL_ERROR_CODES = new Set([
  "RATE_LIMITED", "TOOL_DEADLINE_EXCEEDED", "OUTBOUND_CONTEXT_REQUIRED",
  "REGISTRY_LOCK_TIMEOUT", "ARTIFACT_STORE_FAILED",
  "ENOSPC", "EACCES", "EMFILE", "ENFILE", "EIO", "EROFS",
]);

export function isLocalControlError(error) {
  return LOCAL_CONTROL_ERROR_CODES.has(error?.code);
}

async function awaitWithSignal(promise, signal, timeoutMs, timeoutError) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : timeoutError;
  let timer = null;
  let abortHandler = null;
  const guard = new Promise((_, reject) => {
    abortHandler = () => reject(signal.reason instanceof Error ? signal.reason : timeoutError);
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

export async function assertPublicRemoteUrl(value, {
  resolver = lookup,
  skipDns = false,
  signal = null,
  timeoutMs = 12_000,
} = {}) {
  const canonical = canonicalizeUrl(value);
  if (!canonical) throw new NetworkSafetyError("URL 无效、协议不受支持，或指向本地/私有地址", "UNSAFE_URL");
  const url = new URL(canonical);
  if (url.protocol !== "https:") throw new NetworkSafetyError("网络探测只允许 HTTPS", "INSECURE_PROTOCOL");
  if (isPrivateOrLocalHost(url.hostname)) throw new NetworkSafetyError("拒绝访问本地、私网或保留地址", "PRIVATE_ADDRESS");
  if (skipDns || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return canonical;

  let addresses;
  try {
    addresses = await awaitWithSignal(
      Promise.resolve().then(() => resolver(url.hostname, { all: true, verbatim: true })),
      signal,
      timeoutMs,
      new NetworkSafetyError("DNS 解析超时", "DNS_TIMEOUT"),
    );
  } catch (error) {
    if (isLocalControlError(error) || error instanceof NetworkSafetyError) throw error;
    throw new NetworkSafetyError(`DNS 解析失败：${error.message}`, "DNS_FAILURE");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new NetworkSafetyError("DNS 未返回可验证的公网地址", "DNS_EMPTY");
  }
  for (const item of addresses) {
    const address = typeof item === "string" ? item : item?.address;
    if (!address || isPrivateOrLocalHost(address)) {
      throw new NetworkSafetyError(`DNS 解析包含本地、私网或保留地址：${address || "unknown"}`, "DNS_REBIND_BLOCK");
    }
  }
  return canonical;
}

function pinnedLookup(resolver) {
  return (hostname, options, callback) => {
    Promise.resolve(resolver(hostname, { all: true, verbatim: true }))
      .then((items) => {
        const addresses = (Array.isArray(items) ? items : [items]).map((item) => typeof item === "string" ? { address: item, family: isIP(item) } : item);
        if (!addresses.length) throw new NetworkSafetyError("DNS 未返回可验证的公网地址", "DNS_EMPTY");
        for (const item of addresses) {
          if (!item?.address || isPrivateOrLocalHost(item.address)) throw new NetworkSafetyError(`DNS 连接解析包含本地、私网或保留地址：${item?.address || "unknown"}`, "DNS_REBIND_BLOCK");
        }
        if (typeof options === "object" && options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => callback(error));
  };
}

function nativePinnedFetch(url, { method, headers, body, signal, resolver, maxBytes }) {
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal,
      // Do not let a process-wide proxy/keep-alive Agent bypass the validated
      // lookup callback. A fresh direct Agent makes the TLS socket use the
      // pinned, revalidated DNS answers for this request.
      agent: false,
      lookup: pinnedLookup(resolver),
    }, (response) => {
      const announced = Number(response.headers["content-length"] || 0);
      if (announced > maxBytes) {
        response.destroy();
        reject(new NetworkSafetyError(`响应体 ${announced} 字节，超过上限 ${maxBytes}`, "BODY_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new NetworkSafetyError(`响应体超过上限 ${maxBytes} 字节`, "BODY_TOO_LARGE"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
          else if (value !== undefined) responseHeaders.set(name, String(value));
        }
        const status = response.statusCode || 500;
        const bytes = Buffer.concat(chunks, total);
        resolveResponse(new Response(status === 204 || status === 304 ? null : bytes, { status, headers: responseHeaders }));
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

async function readLimitedBody(response, maxBytes) {
  const announcedLength = Number(response.headers.get("content-length") || 0);
  if (announcedLength > maxBytes) {
    throw new NetworkSafetyError(`响应体 ${announcedLength} 字节，超过上限 ${maxBytes}`, "BODY_TOO_LARGE");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large");
      throw new NetworkSafetyError(`响应体超过上限 ${maxBytes} 字节`, "BODY_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function sanitizedRedirectHeaders(headers, previousUrl, nextUrl) {
  const next = new Headers(headers);
  if (new URL(previousUrl).origin !== new URL(nextUrl).origin) {
    for (const name of [...next.keys()]) {
      if (/(?:authorization|cookie|token|api[-_]?key|subscription[-_]?key|secret)/i.test(name)) next.delete(name);
    }
  }
  return next;
}

export async function safeFetch(value, {
  method = "GET",
  headers = {},
  body,
  timeoutMs = 12_000,
  maxBytes = 2_000_000,
  maxRedirects = 4,
  allowCrossOriginRedirects = false,
  redirectGuard = null,
  fetchImpl = globalThis.fetch,
  resolver = lookup,
  skipDns = false,
  beforeRequest = null,
  requestPhase = "network",
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数");
  let currentUrl = await assertPublicRemoteUrl(value, { resolver, skipDns: true });
  let currentMethod = String(method || "GET").toUpperCase();
  let currentBody = body;
  let currentHeaders = new Headers(headers);
  if (!currentHeaders.has("user-agent")) currentHeaders.set("user-agent", HUANGQUE_USER_AGENT);
  if (!currentHeaders.has("accept")) currentHeaders.set("accept", "application/json, application/xml;q=0.9, text/html;q=0.8, text/plain;q=0.7");
  if (!currentHeaders.has("accept-encoding")) currentHeaders.set("accept-encoding", "identity");
  const redirectChain = [];

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const requestPolicy = beforeRequest ? await beforeRequest({
      url: currentUrl,
      method: currentMethod,
      redirectCount,
      phase: requestPhase,
    }) : null;
    const controller = new AbortController();
    const externalSignal = requestPolicy?.signal;
    currentUrl = await assertPublicRemoteUrl(currentUrl, { resolver, skipDns, signal: externalSignal, timeoutMs });
    const requestSignal = externalSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
    let response;
    try {
      response = fetchImpl === globalThis.fetch && !skipDns
        ? await nativePinnedFetch(currentUrl, { method: currentMethod, headers: currentHeaders, body: currentBody, signal: requestSignal, resolver, maxBytes })
        : await fetchImpl(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: "manual",
          signal: requestSignal,
        });
    } catch (error) {
      if (error instanceof NetworkSafetyError) throw error;
      if (externalSignal?.aborted && isLocalControlError(externalSignal.reason)) throw externalSignal.reason;
      const code = error?.name === "AbortError" || controller.signal.aborted ? "TIMEOUT" : "FETCH_FAILED";
      throw new NetworkSafetyError(`请求失败：${error.message}`, code);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new NetworkSafetyError("重定向响应缺少 Location", "BAD_REDIRECT");
      if (redirectCount === maxRedirects) throw new NetworkSafetyError("重定向次数超过上限", "TOO_MANY_REDIRECTS");
      const nextUrl = await assertPublicRemoteUrl(new URL(location, currentUrl).toString(), { resolver, skipDns: true });
      if (!allowCrossOriginRedirects && new URL(currentUrl).origin !== new URL(nextUrl).origin) {
        throw new NetworkSafetyError("默认拒绝跨域重定向；新域名需要单独执行 robots 与安全探测", "CROSS_ORIGIN_REDIRECT_BLOCKED");
      }
      if (redirectGuard && await redirectGuard({ status: response.status, from: currentUrl, to: nextUrl }) === false) {
        throw new NetworkSafetyError("重定向目标不符合当前 robots.txt 规则", "ROBOTS_REDIRECT_DISALLOWED");
      }
      redirectChain.push({ status: response.status, from: currentUrl, to: nextUrl });
      currentHeaders = sanitizedRedirectHeaders(currentHeaders, currentUrl, nextUrl);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders.delete("content-type");
        currentHeaders.delete("content-length");
      }
      currentUrl = nextUrl;
      continue;
    }

    const bytes = await readLimitedBody(response, maxBytes);
    const contentType = response.headers.get("content-type") || "";
    const charsetMatch = contentType.match(/charset=([^;\s]+)/i);
    let text;
    try {
      text = new TextDecoder(charsetMatch?.[1] || "utf-8", { fatal: false }).decode(bytes);
    } catch {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    return {
      requestedUrl: canonicalizeUrl(value),
      finalUrl: currentUrl,
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      contentType,
      bytes: bytes.byteLength,
      body: text,
      rawBody: bytes,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      redirectChain,
      fetchedAt: new Date().toISOString(),
    };
  }
  throw new NetworkSafetyError("无法完成请求", "FETCH_FAILED");
}

export function parseRobotsRules(robotsText) {
  const MAX_GROUPS = 64;
  const MAX_RULES = 2_000;
  const MAX_PATTERN_LENGTH = 2_048;
  const MAX_WILDCARDS = 128;
  const groups = [];
  let current = null;
  let ruleCount = 0;
  let invalid = false;
  for (const rawLine of String(robotsText || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (value.length > 256) { invalid = true; break; }
      if (!current || current.rules.length > 0) {
        if (groups.length >= MAX_GROUPS) { invalid = true; break; }
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      ruleCount += 1;
      if (ruleCount > MAX_RULES || value.length > MAX_PATTERN_LENGTH || (value.match(/\*/g) || []).length > MAX_WILDCARDS) {
        invalid = true;
        break;
      }
      current.rules.push({ type: field, path: value });
    }
  }
  if (invalid) return [{ agents: ["*"], rules: [], invalid: true }];
  return groups;
}

function linearGlobMatch(pattern, value) {
  let patternIndex = 0;
  let valueIndex = 0;
  let lastStar = -1;
  let retryValueIndex = -1;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      lastStar = patternIndex;
      patternIndex += 1;
      retryValueIndex = valueIndex;
      continue;
    }
    if (lastStar >= 0) {
      patternIndex = lastStar + 1;
      retryValueIndex += 1;
      valueIndex = retryValueIndex;
      continue;
    }
    return false;
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

export function robotsAllowsRules(groups, targetUrl, userAgent = HUANGQUE_USER_AGENT) {
  if (!Array.isArray(groups) || groups.some((group) => group?.invalid === true)) return false;
  const targetPath = `${new URL(targetUrl).pathname}${new URL(targetUrl).search}`;
  const productToken = userAgent.split(/[\s/]/)[0].toLowerCase();
  const specificity = (group) => Math.max(...group.agents.map((agent) => agent === "*" ? 0 : productToken.includes(agent) ? agent.length : -1));
  const bestSpecificity = Math.max(-1, ...groups.map(specificity));
  if (bestSpecificity < 0) return true;
  const matches = (pattern) => {
    const anchored = pattern.endsWith("$");
    const raw = anchored ? pattern.slice(0, -1) : pattern;
    return linearGlobMatch(anchored ? raw : `${raw}*`, targetPath);
  };
  const rules = groups
    .filter((group) => specificity(group) === bestSpecificity)
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path && matches(rule.path));
  rules.sort((left, right) => right.path.replace(/[*$]/g, "").length - left.path.replace(/[*$]/g, "").length || (left.type === "allow" ? -1 : 1));
  return rules[0]?.type !== "disallow";
}

export function robotsAllows(robotsText, targetUrl, userAgent = HUANGQUE_USER_AGENT) {
  return robotsAllowsRules(parseRobotsRules(robotsText), targetUrl, userAgent);
}

export async function fetchRobotsPolicy(targetUrl, options = {}) {
  const target = new URL(await assertPublicRemoteUrl(targetUrl, options));
  const robotsUrl = `${target.origin}/robots.txt`;
  try {
    const response = await safeFetch(robotsUrl, { ...options, maxBytes: Math.min(options.maxBytes || 250_000, 250_000) });
    if (response.status === 404 || response.status === 410) return { allowed: true, status: response.status, url: robotsUrl, reason: "robots_absent" };
    if (!response.ok) return { allowed: false, status: response.status, url: robotsUrl, reason: "robots_unavailable_fail_closed" };
    const sitemaps = String(response.body || "").split(/\r?\n/).flatMap((line) => {
      const value = line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1];
      const canonical = value ? canonicalizeUrl(value) : null;
      return canonical ? [canonical] : [];
    });
    const rules = parseRobotsRules(response.body);
    return {
      allowed: robotsAllowsRules(rules, targetUrl),
      status: response.status,
      url: robotsUrl,
      reason: robotsAllowsRules(rules, targetUrl) ? "robots_allowed" : "robots_disallowed",
      contentHash: response.contentHash,
      sitemaps,
      rules,
    };
  } catch (error) {
    if (isLocalControlError(error)) throw error;
    return { allowed: false, status: null, url: robotsUrl, reason: "robots_fetch_failed_fail_closed", error: error.message };
  }
}
