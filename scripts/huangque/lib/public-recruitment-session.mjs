import { jsonStructureWithinBudget } from "./adapters.mjs";
import { robotsAllowsRules, safeFetch } from "./http.mjs";

const SESSION_PROVIDERS = new Set(["ByteDance", "FeishuRecruitment"]);

function csrfCookie(setCookie) {
  const match = String(setCookie || "").match(/(?:^|[,;]\s*)atsx-csrf-token=([^;,\s]+)/i);
  return match ? `atsx-csrf-token=${match[1]}` : null;
}

/**
 * ByteDance and Feishu Recruitment public career pages establish an ordinary anonymous CSRF
 * session before their read-only job search request. This does not log in or
 * bypass access control: it reproduces the public frontend's documented
 * same-origin safety handshake and keeps the ephemeral values in memory only.
 */
export async function createPublicRecruitmentSession(candidate, endpoint, {
  fetchOptions = {},
  robots = null,
} = {}) {
  if (!SESSION_PROVIDERS.has(candidate?.provider)) return { headers: {}, evidence: null };
  const target = new URL(endpoint);
  const feishu = candidate.provider === "FeishuRecruitment";
  const csrfUrl = `${target.origin}/api/v1/csrf/token`;
  if (robots?.rules && !robotsAllowsRules(robots.rules, csrfUrl)) {
    throw Object.assign(new Error("robots.txt 不允许建立公开招聘查询会话"), { code: "ROBOTS_DISALLOWED" });
  }
  const response = await safeFetch(csrfUrl, {
    ...fetchOptions,
    method: "POST",
    headers: {
      ...(fetchOptions.headers || {}),
      "content-type": "application/json;charset=UTF-8",
      "portal-channel": feishu ? "saas-career" : "office",
      "portal-platform": "pc",
    },
    ...(feishu ? {} : { body: JSON.stringify({ portal_entrance: 1 }) }),
    maxBytes: 200_000,
    redirectGuard: ({ to }) => robotsAllowsRules(robots?.rules || [], to),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`公开招聘 CSRF 会话端点返回 HTTP ${response.status}`), { code: "PUBLIC_SESSION_HTTP_ERROR", status: response.status });
  }
  if (!jsonStructureWithinBudget(response.body, 10_000)) {
    throw Object.assign(new Error("公开招聘 CSRF 会话响应结构超过安全上限"), { code: "PUBLIC_SESSION_SCHEMA_DRIFT" });
  }
  let payload;
  try { payload = JSON.parse(response.body); }
  catch { throw Object.assign(new Error("公开招聘 CSRF 会话返回非 JSON"), { code: "PUBLIC_SESSION_SCHEMA_DRIFT" }); }
  if (payload?.code !== 0) {
    throw Object.assign(new Error(`公开招聘 CSRF 会话返回业务错误 ${payload?.code ?? "unknown"}`), { code: "PUBLIC_SESSION_UPSTREAM_ERROR" });
  }
  const token = typeof payload?.data?.token === "string" ? payload.data.token : null;
  const cookie = csrfCookie(response.headers?.["set-cookie"]);
  if (!token || !cookie) {
    throw Object.assign(new Error("公开招聘 CSRF 会话缺少 token 或匿名 cookie"), { code: "PUBLIC_SESSION_SCHEMA_DRIFT" });
  }
  return {
    headers: { cookie, "x-csrf-token": token },
    evidence: {
      kind: "anonymous_public_csrf_session",
      url: csrfUrl,
      status: response.status,
      contentHash: response.contentHash,
      fetchedAt: response.fetchedAt,
      credentialsPersisted: false,
    },
  };
}
