import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeUrl, isPrivateOrLocalHost } from "../scripts/huangque/lib/source-discovery.mjs";
import { assertPublicRemoteUrl, fetchRobotsPolicy, robotsAllows, safeFetch } from "../scripts/huangque/lib/http.mjs";
import { FileArtifactStore } from "../scripts/huangque/lib/artifacts.mjs";

test("URL safety rejects local suffixes, carrier NAT, mapped IPv6 and reserved ranges", () => {
  for (const value of [
    "https://localhost./jobs",
    "https://service.local./jobs",
    "http://100.64.0.1/jobs",
    "http://192.0.2.8/jobs",
    "http://240.0.0.1/jobs",
    "http://255.255.255.255/jobs",
    "http://[::ffff:127.0.0.1]/jobs",
    "http://[2002:7f00:1::]/jobs",
    "http://[64:ff9b::7f00:1]/jobs",
    "http://[fc00::1]/jobs",
    "http://[fec0::1]/jobs",
    "http://[::7f00:1]/jobs",
    "http://[::c0a8:1]/jobs",
  ]) assert.equal(canonicalizeUrl(value), null, value);
});

test("URL safety allows public IPv4 and blocks only private mapped IPv4", async () => {
  assert.equal(isPrivateOrLocalHost("8.8.8.8"), false);
  assert.equal(isPrivateOrLocalHost("93.184.216.34"), false);
  assert.equal(isPrivateOrLocalHost("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateOrLocalHost("::ffff:808:808"), false);
  assert.equal(isPrivateOrLocalHost("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("::ffff:7f00:1"), true);
  assert.equal(canonicalizeUrl("https://8.8.8.8/jobs"), "https://8.8.8.8/jobs");
  assert.equal(
    await assertPublicRemoteUrl("https://public.example/jobs", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    }),
    "https://public.example/jobs",
  );
});

test("DNS answers and every redirect are revalidated against SSRF", async () => {
  await assert.rejects(
    () => assertPublicRemoteUrl("https://public.example/jobs", { resolver: async () => [{ address: "169.254.169.254", family: 4 }] }),
    (error) => error.code === "DNS_REBIND_BLOCK",
  );
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secrets" } });
  await assert.rejects(
    () => safeFetch("https://public.example/jobs", { fetchImpl, skipDns: true }),
    (error) => error.code === "UNSAFE_URL",
  );
  let resolutions = 0;
  await assert.rejects(
    () => safeFetch("https://rebind.invalid/jobs", {
      resolver: async () => resolutions++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 1000,
    }),
    (error) => error.code === "DNS_REBIND_BLOCK" || error.cause?.code === "DNS_REBIND_BLOCK",
  );
  assert.equal(resolutions, 2, "DNS 必须在预检和实际 TLS 建连时各验证一次");
});

test("safeFetch blocks cross-origin redirects by default", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://b.example/final" } });
  await assert.rejects(
    () => safeFetch("https://a.example/start", { fetchImpl, skipDns: true }),
    (error) => error.code === "CROSS_ORIGIN_REDIRECT_BLOCKED",
  );
});

test("explicit cross-origin redirect mode strips credentials and still enforces body size", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, authorization: options.headers.get("authorization"), apiKey: options.headers.get("x-api-key") });
    if (url === "https://a.example/start") return new Response(null, { status: 302, headers: { location: "https://b.example/final" } });
    return new Response("x".repeat(20), { status: 200, headers: { "content-type": "text/plain" } });
  };
  await assert.rejects(
    () => safeFetch("https://a.example/start", { fetchImpl, skipDns: true, allowCrossOriginRedirects: true, headers: { authorization: "Bearer secret", "x-api-key": "also-secret" }, maxBytes: 10 }),
    (error) => error.code === "BODY_TOO_LARGE",
  );
  assert.deepEqual(seen, [
    { url: "https://a.example/start", authorization: "Bearer secret", apiKey: "also-secret" },
    { url: "https://b.example/final", authorization: null, apiKey: null },
  ]);
});

test("redirect guard blocks a same-origin path disallowed by the fetched robots policy", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /jobs\nDisallow: /private\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/jobs")) return new Response(null, { status: 302, headers: { location: "/private" } });
    return new Response("secret", { headers: { "content-type": "text/plain" } });
  };
  const policy = await fetchRobotsPolicy("https://public.example/jobs", { fetchImpl, skipDns: true });
  await assert.rejects(
    () => safeFetch("https://public.example/jobs", {
      fetchImpl,
      skipDns: true,
      redirectGuard: ({ to }) => robotsAllows("User-agent: *\nAllow: /jobs\nDisallow: /private\n", to),
    }),
    (error) => error.code === "ROBOTS_REDIRECT_DISALLOWED",
  );
  assert.equal(policy.allowed, true);
});

test("robots parser applies the most specific allow/disallow rule", () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/jobs\n`;
  assert.equal(robotsAllows(robots, "https://example.com/private/jobs/1"), true);
  assert.equal(robotsAllows(robots, "https://example.com/private/account"), false);
  const grouped = `User-agent: HuangqueJobSourceAgent\nUser-agent: companion\nDisallow: /*.pdf$\nAllow: /public/*.pdf$\n\nUser-agent: *\nDisallow: /`;
  assert.equal(robotsAllows(grouped, "https://example.com/private/report.pdf"), false);
  assert.equal(robotsAllows(grouped, "https://example.com/public/report.pdf"), true);
});

test("robots fetch errors fail closed", async () => {
  const policy = await fetchRobotsPolicy("https://public.example/jobs", {
    skipDns: true,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, "robots_fetch_failed_fail_closed");
});

test("robots DNS failures fail closed instead of aborting the daily pipeline", async () => {
  const policy = await fetchRobotsPolicy("https://unresolvable.example/jobs", {
    resolver: async () => { throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }); },
  });
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, "robots_fetch_failed_fail_closed");
  assert.match(policy.error, /DNS/);
  assert.equal(policy.url, "https://unresolvable.example/robots.txt");
});

test("content-addressed artifact writes are safe under same-process concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-artifacts-"));
  const store = new FileArtifactStore(directory);
  const contentHash = createHash("sha256").update("same body").digest("hex");
  const response = { contentHash, body: "same body", requestedUrl: "https://example.com/jobs", finalUrl: "https://example.com/jobs", status: 200, contentType: "text/plain", bytes: 9, fetchedAt: "2026-08-20T00:00:00.000Z" };
  const outputs = await Promise.all(Array.from({ length: 10 }, (_, index) => store.put(response, { runId: `run-${index}` })));
  assert.equal(outputs.length, 10);
  assert.equal((await store.get(contentHash)).body, "same body");
});

test("artifacts preserve the exact non-UTF8 bytes used by the HTTP content hash", async () => {
  const raw = Buffer.from([0xc4, 0xe3]);
  const response = await safeFetch("https://example.com/gbk", {
    skipDns: true,
    fetchImpl: async () => new Response(raw, { headers: { "content-type": "text/plain; charset=gbk" } }),
  });
  assert.equal(response.body, "你");
  assert.deepEqual(response.rawBody, raw);
  const directory = await mkdtemp(join(tmpdir(), "huangque-artifacts-gbk-"));
  const store = new FileArtifactStore(directory);
  await store.put(response);
  const replay = await store.get(response.contentHash);
  assert.deepEqual(replay.rawBody, raw);
  assert.equal(createHash("sha256").update(replay.rawBody).digest("hex"), response.contentHash);
  assert.equal(replay.body, "你");
  assert.equal(replay.metadata.charset, "gbk");
});
