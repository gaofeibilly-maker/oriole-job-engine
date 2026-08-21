import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildBaiduRequest, extractSitePattern, runBaiduProvider, runCommonCrawlProvider, runPublicCatalogProvider, truncateBaiduQuery } from "../scripts/huangque/lib/providers.mjs";
import { completedDiscoveryTaskIds, discoveryExecutionStatus, HuangqueEngine } from "../scripts/huangque/lib/engine.mjs";
import { dueQueryBuckets, expandQueryPlan, queryTaskProviders, selectDueQueryTasks } from "../scripts/huangque/lib/query-plan.mjs";
import { discoverSourceCandidates } from "../scripts/huangque/lib/source-discovery.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("query plan expands dimensions and honors bucket cadence", () => {
  const plan = {
    schemaVersion: "huangque.query-plan.v1",
    buckets: [{ id: "district", cadenceDays: 3, dimensions: { district: ["朝阳", "海淀"] }, templates: ["北京 {district} 招聘"] }],
  };
  assert.deepEqual(expandQueryPlan(plan).map((item) => item.query), ["北京 朝阳 招聘", "北京 海淀 招聘"]);
  const state = { district: { lastCompletedAt: "2026-08-19T00:00:00.000Z" } };
  assert.equal(dueQueryBuckets(plan, state, new Date("2026-08-20T00:00:00.000Z"))[0].due, false);
  assert.equal(selectDueQueryTasks(plan, state, { now: new Date("2026-08-23T00:00:00.000Z") }).length, 2);
});

test("query plan can expand the complete prefecture-level region dimension", () => {
  const plan = {
    schemaVersion: "huangque.query-plan.v1",
    buckets: [{ id: "cities", cadenceDays: 7, dimensions: { city: ["$all_prefecture_level"] }, templates: ["{city} 招聘 官方"] }],
  };
  const tasks = expandQueryPlan(plan);
  assert.equal(tasks.length, 365);
  assert.ok(tasks.some((task) => task.query.includes("武汉市")));
  assert.ok(tasks.some((task) => task.query.includes("喀什地区")));
});

test("Baidu provider uses official JSON endpoint contract and never logs the key", async () => {
  let observed;
  const fetchImpl = async (url, options) => {
    observed = { url, authorization: options.headers.get("authorization"), payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ request_id: "req-1", references: [{ title: "Example Beijing jobs", url: "https://jobs.example.com/careers", snippet: "北京 招聘", date: "2026-08-19", rerank_score: 0.9 }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const output = await runBaiduProvider([{ id: "q1", query: "北京 招聘 官网" }], { apiKey: "super-secret", fetchOptions: { fetchImpl, skipDns: true } });
  assert.equal(output.providerStatus, "ok");
  assert.equal(output.hits.length, 1);
  assert.equal(observed.authorization, "Bearer super-secret");
  assert.equal(observed.payload.search_source, "baidu_search_v2");
  assert.equal(buildBaiduRequest("北京 招聘").resource_type_filter[0].top_k, 20);
  assert.ok(!JSON.stringify(output).includes("super-secret"));
  assert.ok(truncateBaiduQuery("北".repeat(100)).length <= 36);
});

test("Baidu missing credential is non-fatal", async () => {
  const output = await runBaiduProvider([{ id: "q1", query: "北京 招聘" }], { apiKey: "" });
  assert.equal(output.providerStatus, "not_configured");
  assert.equal(output.hits.length, 0);
});

test("Baidu opens a circuit on the first upstream daily-quota response", async () => {
  let requests = 0;
  const output = await runBaiduProvider([
    { id: "q1", query: "北京 招聘" },
    { id: "q2", query: "上海 招聘" },
    { id: "q3", query: "武汉 招聘" },
  ], {
    apiKey: "test-secret",
    maxQueries: 3,
    fetchOptions: {
      skipDns: true,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(JSON.stringify({
            request_id: "req-before-quota",
            references: [{ title: "北京招聘", url: "https://jobs.example.com/beijing" }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          code: "QUOTA_USER_DAILY_FREE",
          message: "Daily free quota per user for Web Search exceeded",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  });

  assert.equal(requests, 2);
  assert.equal(output.providerStatus, "partial");
  assert.equal(output.hits.length, 1);
  assert.equal(output.metadata.requestCount, 2);
  assert.equal(output.metadata.queryCount, 2);
  assert.equal(output.metadata.selectedTaskCount, 3);
  assert.equal(output.metadata.upstreamQuotaExhausted, true);
  assert.equal(output.metadata.haltedReason, "BAIDU_UPSTREAM_DAILY_QUOTA_EXHAUSTED");
  assert.equal(output.metadata.unattemptedTaskCount, 1);
  assert.equal(output.exhausted, false);
  assert.deepEqual(output.metadata.completedTaskIds, ["q1"]);
  assert.deepEqual(output.metadata.failedTaskIds, ["q2"]);
  assert.equal(output.warnings.length, 1);
  assert.equal(discoveryExecutionStatus([{ ...output, status: output.providerStatus }], { taskCount: 3 }), "partial");
  assert.ok(!JSON.stringify(output).includes("test-secret"));
});

test("Baidu redacts an API key echoed by an untrusted upstream error", async () => {
  const apiKey = "red-team-secret";
  const output = await runBaiduProvider([{ id: "q1", query: "北京 招聘" }], {
    apiKey,
    maxQueries: 1,
    fetchOptions: {
      skipDns: true,
      fetchImpl: async () => new Response(JSON.stringify({
        error_code: "UPSTREAM_REJECTED",
        error_msg: `request contained Authorization: Bearer ${apiKey}; raw=${apiKey}`,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  });

  const serialized = JSON.stringify(output);
  assert.equal(output.providerStatus, "failed");
  assert.equal(output.metadata.failedTaskIds[0], "q1");
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(!serialized.includes(apiKey));
});

test("Baidu redacts credentials from successful payload fields and drops credentialed URLs", async () => {
  const apiKey = "red-team-success-secret";
  const output = await runBaiduProvider([{ id: "q1", query: "北京 招聘" }], {
    apiKey,
    maxQueries: 1,
    fetchOptions: {
      skipDns: true,
      fetchImpl: async () => new Response(JSON.stringify({
        request_id: `request-${apiKey}`,
        references: [
          {
            title: `title-${apiKey}`,
            url: "https://jobs.example.com/list",
            snippet: `Authorization: Bearer ${apiKey}`,
          },
          {
            title: "unsafe URL",
            url: `https://jobs.example.com/list?token=${apiKey}`,
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  });

  const serialized = JSON.stringify(output);
  assert.equal(output.providerStatus, "ok");
  assert.equal(output.hits.length, 1);
  assert.equal(output.warnings.length, 1);
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(!serialized.includes(apiKey));
  assert.ok(!serialized.includes("token="));
});

test("Common Crawl with no eligible site task is not reported as an online success", async () => {
  let fetched = false;
  const output = await runCommonCrawlProvider([{ id: "keyword-only", query: "全国 招聘 官网" }], {
    fetchOptions: { fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); }, skipDns: true },
  });
  assert.equal(output.providerStatus, "not_applicable");
  assert.equal(output.metadata.requestCount, 0);
  assert.deepEqual(output.metadata.completedTaskIds, []);
  assert.equal(fetched, false);
});

test("discovery tasks expose provider capability and leave Baidu-only work visibly blocked", () => {
  const plan = {
    schemaVersion: "huangque.query-plan.v1",
    buckets: [{ id: "mixed", cadenceDays: 1, queries: ["全国 招聘 官网", "site:gov.cn 招聘 岗位"] }],
  };
  assert.deepEqual(queryTaskProviders("全国 招聘 官网"), ["baidu"]);
  assert.deepEqual(queryTaskProviders("site:gov.cn 招聘 岗位"), ["baidu", "common_crawl"]);
  assert.deepEqual(selectDueQueryTasks(plan, {}, { availableProviders: ["common_crawl"] }).map((task) => task.query), ["site:gov.cn 招聘 岗位"]);
  assert.equal(selectDueQueryTasks(plan, {}, { availableProviders: [] }).length, 0);
  assert.equal(selectDueQueryTasks(plan, {}).length, 2);
});

test("official catalog success never masks failed query providers for cadence", () => {
  const tasks = [
    { id: "a1", bucketId: "a" },
    { id: "a2", bucketId: "a" },
    { id: "b1", bucketId: "b" },
  ];
  assert.deepEqual(completedDiscoveryTaskIds(tasks, [
    { provider: "official_catalog", status: "ok", metadata: {} },
    { provider: "baidu", status: "failed", metadata: { completedTaskIds: [] } },
    { provider: "common_crawl", status: "ok", metadata: { completedTaskIds: ["a1", "a2"] } },
  ]), ["a1", "a2"]);
});

test("official catalog keeps declared nationwide coverage independent from the first search task", async () => {
  const output = await runPublicCatalogProvider([{ id: "hubei", query: "湖北省 招聘", dimensions: { province: "湖北省" } }], {
    catalog: {
      schemaVersion: "huangque.public-catalog.v1",
      scope: "全国",
      updatedAt: "2026-08-20T00:00:00.000Z",
      entries: [{ id: "national", title: "国家大学生就业服务平台", url: "https://www.ncss.cn/student/jobs/index.html", snippet: "全国校园招聘职位", publisher: "国家大学生就业服务平台", region: "全国", regionCode: "CN", coverageRegions: "all_provincial_regions" }],
    },
  });
  assert.equal(output.hits[0].query, "全国 官方招聘目录");
  assert.equal(output.hits[0].dimensions.regionCode, "CN");
  const input = { schemaVersion: "huangque.discovery-input.v1", metadata: { scope: "全国", observedAt: "2026-08-20T00:00:00.000Z" }, queries: [{ id: "catalog", query: output.hits[0].query, channel: "official_catalog", results: output.hits.map((hit) => ({ ...hit, providerEvidence: hit.evidence })) }] };
  const candidate = discoverSourceCandidates(input).candidates[0];
  assert.deepEqual(candidate.regions.map((region) => region.label), ["全国"]);
  assert.equal(candidate.regions[0].basis, "official_catalog");
});

test("official catalog turns the bounded employer watchlist into executable discovery candidates", async () => {
  const output = await runPublicCatalogProvider([], {
    now: new Date("2026-08-20T00:00:00.000Z"),
    catalog: {
      schemaVersion: "huangque.public-catalog.v1",
      updatedAt: "2026-08-20T00:00:00.000Z",
      scope: "全国",
      entries: [{ id: "existing", title: "字节跳动招聘", url: "https://jobs.bytedance.com/experienced/position", publisher: "字节跳动", authority: "official_employer" }],
    },
    channelPlan: {
      schemaVersion: "huangque.source-channel-plan.v1",
      targetInventory: {
        employers: [
          { id: "bytedance", name: "字节跳动", match: { hosts: ["jobs.bytedance.com"] }, audit: { officialRecruitmentUrl: "https://jobs.bytedance.com/" } },
          { id: "tencent", name: "腾讯", match: { hosts: ["careers.tencent.com"] }, audit: { officialRecruitmentUrl: "https://careers.tencent.com/" } },
        ],
      },
    },
  });
  assert.equal(output.providerStatus, "ok");
  assert.equal(output.metadata.directoryEntries, 1);
  assert.equal(output.metadata.employerWatchlistEntries, 1);
  assert.equal(output.hits.length, 2);
  const tencent = output.hits.find((hit) => hit.url === "https://careers.tencent.com/");
  assert.equal(tencent.evidence.kind, "official_employer_watchlist");
  assert.equal(tencent.evidence.authority, "official_employer");
  assert.equal(tencent.evidence.publisher, "腾讯");
});

test("all 19 versioned employer targets enter discovery candidates and the Registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-employer-watchlist-"));
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
  });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  const run = await engine.discoverSources({ providers: ["official_catalog"], force: true, maxQueries: 1 });
  const [plan, state, coverage] = await Promise.all([
    readFile(resolve(projectRoot, "data/huangque/source-channel-plan.json"), "utf8").then(JSON.parse),
    engine.registry.snapshot(),
    engine.sourceCoverage(),
  ]);

  const matchesTarget = (candidate, target) => {
    const expected = new Set(target.match.hosts.map((host) => String(host).toLowerCase()));
    const values = [candidate.sourceRootUrl, candidate.entryUrl, ...(candidate.discoveredUrls || [])];
    return values.some((value) => {
      try {
        const actual = new URL(value).hostname.toLowerCase();
        return [...expected].some((host) => actual === host || actual.endsWith(`.${host}`));
      } catch {
        return false;
      }
    });
  };

  assert.equal(plan.targetInventory.employers.length, 19);
  const targetCandidates = plan.targetInventory.employers.map((target) => ({
    target,
    matches: run.discovery.candidates.filter((candidate) => matchesTarget(candidate, target)),
  }));
  assert.ok(targetCandidates.every(({ matches }) => matches.length === 1));
  assert.equal(targetCandidates.reduce((total, item) => total + item.matches.length, 0), 19);
  assert.equal(targetCandidates.find(({ target }) => target.id === "bytedance").matches[0].status, "already_registered");
  assert.ok(targetCandidates.filter(({ target }) => target.id !== "bytedance").every(({ matches }) => matches[0].status === "ready_for_probe"));

  const persistedTargets = plan.targetInventory.employers.map((target) => state.sources.filter((source) => matchesTarget(source.candidate, target)));
  assert.ok(persistedTargets.every((matches) => matches.length === 1));
  assert.equal(coverage.summary.employerTargetsPlanned, 19);
  assert.equal(coverage.targets.filter((target) => target.state === "missing").length, 0);
  assert.equal(coverage.targets.filter((target) => target.state === "covered").length, 1);
  assert.equal(coverage.targets.filter((target) => target.state === "discovered").length, 18);
});

test("partial discovery cycles resume remaining tasks and round-robin large buckets", () => {
  const plan = {
    schemaVersion: "huangque.query-plan.v1",
    buckets: [
      { id: "large", cadenceDays: 1, queries: ["L1", "L2", "L3", "L4"] },
      { id: "small", cadenceDays: 1, queries: ["S1", "S2"] },
    ],
  };
  const first = selectDueQueryTasks(plan, {}, { maxQueries: 3 });
  assert.deepEqual(first.map((task) => task.query), ["L1", "S1", "L2"]);
  const state = {
    large: { completedTaskIds: first.filter((task) => task.bucketId === "large").map((task) => task.id) },
    small: { completedTaskIds: first.filter((task) => task.bucketId === "small").map((task) => task.id) },
  };
  const second = selectDueQueryTasks(plan, state, { maxQueries: 3 });
  assert.deepEqual(second.map((task) => task.query), ["L3", "S2", "L4"]);
  assert.equal(new Set([...first, ...second].map((task) => task.id)).size, 6);
});

test("Common Crawl uses latest advertised index only for controlled site queries", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/collinfo.json")) return new Response(JSON.stringify([{ id: "CC-MAIN-2026-30", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-30-index" }]), { headers: { "content-type": "application/json" } });
    return new Response(`${JSON.stringify({ timestamp: "20260819010203", url: "https://example.com/careers/jobs", mime: "text/html", status: "200", digest: "ABC" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
  };
  const output = await runCommonCrawlProvider([
    { id: "site", query: "site:example.com/careers 北京 招聘" },
    { id: "keyword", query: "北京 招聘" },
  ], { fetchOptions: { fetchImpl, skipDns: true } });
  assert.equal(extractSitePattern("site:example.com/careers 招聘"), "example.com/careers/*");
  assert.equal(output.hits.length, 1);
  assert.equal(output.metadata.indexId, "CC-MAIN-2026-30");
  assert.equal(urls.length, 2);
  assert.match(urls[1], /CC-MAIN-2026-30-index/);
});
