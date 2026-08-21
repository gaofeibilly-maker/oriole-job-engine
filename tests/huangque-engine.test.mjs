import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectionDueState, HuangqueEngine, jobWithEffectiveValidity, schedulerObservationIsLive } from "../scripts/huangque/lib/engine.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);

function fixtureNetwork(payloadRef) {
  return async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.startsWith("https://api.lever.co/v0/postings/novel-company")) {
      return new Response(JSON.stringify(payloadRef.value), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fixture URL ${url}`);
  };
}

test("end-to-end source submission requires probe and human approval before idempotent collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-engine-"));
  const payloadRef = { value: [{
    id: "job-1",
    text: "Operations Manager",
    categories: { location: "Beijing, China", department: "Operations", commitment: "Full-time" },
    hostedUrl: "https://jobs.lever.co/novel-company/job-1",
    applyUrl: "https://jobs.lever.co/novel-company/job-1/apply",
    createdAt: Date.parse("2026-08-19T00:00:00Z"),
    descriptionPlain: "Lead operations in Beijing.",
  }] };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    fetchOptions: { fetchImpl: fixtureNetwork(payloadRef), skipDns: true },
  });
  const submitted = await engine.submitSource({ url: "https://jobs.lever.co/novel-company", title: "Novel Company Beijing jobs" });
  const sourceId = submitted.discovery.candidates[0].id;
  await assert.rejects(
    () => engine.collectJobs({ sourceId, commit: true }),
    (error) => error.code === "SOURCE_NOT_APPROVED" && Boolean(error.runId),
  );

  const probed = await engine.probeSource({ sourceId });
  assert.equal(probed.probe.verificationState, "verified");
  let listed = await engine.listSources({});
  let source = listed.sources.find((item) => item.id === sourceId);
  assert.equal(source.lifecycle, "probed");
  assert.equal(source.reviewStatus, "pending");
  assert.equal(source.collectionEnabled, false);

  await assert.rejects(
    () => engine.reviewSource({ sourceId, decision: "approve", reason: "证据完整", reviewedBy: "tester", expectedRevision: source.revision - 1, confirmation: true }),
    (error) => error.code === "REVISION_CONFLICT",
  );
  source = await engine.reviewSource({ sourceId, decision: "approve", reason: "真实接口、北京样本与申请入口均已核验", reviewedBy: "tester", expectedRevision: source.revision, confirmation: true });
  assert.equal(source.lifecycle, "approved");

  const preview = await engine.collectJobs({ sourceId, commit: false });
  assert.equal(preview.stats.jobsObserved, 1);
  assert.equal((await engine.listJobs({})).total, 0);
  assert.equal((await engine.registry.snapshot()).sources.find((item) => item.id === sourceId).collection, null);
  const committed = await engine.collectJobs({ sourceId, commit: true });
  assert.equal(committed.stats.jobsNew, 1);
  assert.equal((await engine.listJobs({})).total, 1);
  const repeated = await engine.collectJobs({ sourceId, commit: true });
  assert.equal(repeated.stats.jobsNew, 0);
  assert.equal(repeated.results[0].storage.unchanged, 1);

  payloadRef.value[0] = { ...payloadRef.value[0], text: "Senior Operations Manager" };
  const changed = await engine.collectJobs({ sourceId, commit: true });
  assert.equal(changed.stats.jobsUpdated, 1);
  assert.equal((await engine.listJobs({})).jobs[0].version, 2);
  payloadRef.value = [];
  await engine.collectJobs({ sourceId, commit: true });
  await engine.collectJobs({ sourceId, commit: true });
  const afterEmptyFeeds = (await engine.listJobs({})).jobs[0];
  assert.equal(afterEmptyFeeds.status, "needs_review");
  assert.equal(afterEmptyFeeds.consecutiveMissing, 2);
  await engine.collectJobs({ sourceId, commit: true });
  assert.equal((await engine.listJobs({})).jobs[0].status, "closed");
  assert.equal((await engine.registry.snapshot()).jobVersions.length, 2);
  source = (await engine.listSources({})).sources.find((item) => item.id === sourceId);
  await engine.reviewSource({ sourceId, decision: "reject", reason: "来源已撤销", reviewedBy: "tester", expectedRevision: source.revision, confirmation: true });
  assert.equal((await engine.listJobs({})).total, 0);
  const registryText = await readFile(join(directory, "state.json"), "utf8");
  assert.ok(!registryText.includes("super-secret"));
});

test("fake ATS tenant and login wall never become verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-fail-"));
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    return new Response("<html><title>Login required</title><body>Please log in</body></html>", { headers: { "content-type": "text/html" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const submitted = await engine.submitSource({ url: "https://jobs.lever.co/not-a-real-tenant", title: "Beijing jobs" });
  const sourceId = submitted.discovery.candidates[0].id;
  const result = await engine.probeSource({ sourceId });
  assert.equal(result.probe.verificationState, "access_restricted");
  const source = (await engine.listSources({})).sources[0];
  assert.equal(source.collectionEnabled, false);
  await assert.rejects(
    () => engine.reviewSource({ sourceId, decision: "approve", reason: "should fail", reviewedBy: "tester", expectedRevision: source.revision, confirmation: true }),
    (error) => error.code === "SOURCE_NOT_VERIFIED",
  );
});

test("probing an official directory emits cross-origin recruitment links as unapproved candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-directory-spider-"));
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url === "https://directory.example.gov.cn/recruitment-links") {
      return new Response('<html><title>地方人社就业目录</title><a href="https://hr.wuhan.gov.cn/jobs">武汉市人社招聘就业</a></html>', { headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected fixture URL ${url}`);
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const candidate = {
    id: "official-directory-fixture",
    sourceKey: "url:https://directory.example.gov.cn/recruitment-links",
    name: "地方人社就业目录",
    publisher: "示例政府目录",
    sourceType: "official_source_directory",
    sourceRootUrl: "https://directory.example.gov.cn/recruitment-links",
    authority: "official_government_directory",
    regions: [{ countryCode: "CN", provinceCode: null, cityCode: null, label: "全国" }],
    status: "ready_for_probe",
    discoveryPriorityScore: 90,
    queryIds: ["fixture-directory"],
    evidence: [{ channel: "official_catalog", queryId: "fixture-directory" }],
    discoveredUrls: ["https://directory.example.gov.cn/recruitment-links"],
    titles: ["地方人社就业目录"],
    decision: { status: "ready_for_probe", reasonCodes: ["OFFICIAL_SOURCE_DIRECTORY"], decidedBy: "fixture" },
  };
  await engine.registry.upsertCandidates({ candidates: [candidate] }, "fixture-directory-run");
  const result = await engine.probeSource({ sourceId: candidate.id });
  assert.equal(result.probe.sourceClues.length, 1);
  assert.equal(result.discoveredSourceIds.length, 1);
  const state = await engine.registry.snapshot();
  const discovered = state.sources.find((source) => source.id === result.discoveredSourceIds[0]);
  assert.equal(discovered.candidate.sourceRootUrl, "https://hr.wuhan.gov.cn/jobs");
  assert.equal(discovered.candidate.status, "ready_for_probe");
  assert.equal(discovered.collectionEnabled, false);
  assert.ok(discovered.candidate.decision.reasonCodes.includes("OFFICIAL_GOVERNMENT_DIRECTORY_LINK"));
});

test("pipeline and runDue drain the persistent ready-for-probe backlog without auto-approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-probe-backlog-"));
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    const tenant = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return new Response(JSON.stringify([{
      id: `${tenant}-job`,
      text: `${tenant} Beijing Engineer`,
      categories: { location: "Beijing, China" },
      hostedUrl: `https://jobs.lever.co/${tenant}/${tenant}-job`,
      applyUrl: `https://jobs.lever.co/${tenant}/${tenant}-job/apply`,
    }]), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidates = [
    ["high", 90],
    ["medium", 80],
    ["low", 70],
  ].map(([tenant, discoveryPriorityScore]) => ({
    id: `lever-${tenant}`,
    sourceKey: `ats:lever:${tenant}`,
    name: tenant,
    provider: "Lever",
    tenant,
    sourceType: "official_ats",
    sourceRootUrl: `https://jobs.lever.co/${tenant}`,
    publicApiUrl: `https://api.lever.co/v0/postings/${tenant}?mode=json`,
    status: "ready_for_probe",
    authority: "employer_controlled_board",
    discoveryPriorityScore,
    queryIds: [`query-${tenant}`],
    evidence: [{ channel: "fixture", queryId: `query-${tenant}` }],
    discoveredUrls: [`https://jobs.lever.co/${tenant}`],
    titles: [`${tenant} jobs`],
    decision: { status: "ready_for_probe", reasonCodes: ["KNOWN_PUBLIC_ATS_PATTERN"], decidedBy: "fixture" },
  }));
  await engine.registry.upsertCandidates({ candidates }, "discovery-original");
  engine.discoverSources = async () => ({
    runId: "discovery-empty",
    discovery: { stats: { candidateSources: 0 }, candidates: [] },
  });

  const first = await engine.runPipeline({ maxQueries: 0, maxProbes: 1 });
  assert.deepEqual(first.probeQueue, {
    eligibleSources: 3,
    selectedSources: 1,
    remainingSources: 2,
    selectedSourceIds: ["lever-high"],
  });
  assert.deepEqual(first.probes.map((probe) => probe.sourceId), ["lever-high"]);

  const second = await engine.runDue({ commitApproved: false, maxQueries: 0, maxProbes: 1, maxCollections: 0 });
  assert.deepEqual(second.probeQueue, {
    eligibleSources: 2,
    selectedSources: 1,
    remainingSources: 1,
    selectedSourceIds: ["lever-medium"],
  });
  assert.deepEqual(second.probes.map((probe) => probe.sourceId), ["lever-medium"]);
  assert.equal(second.collection.dueSources, 0);

  const state = await engine.registry.snapshot();
  const high = state.sources.find((source) => source.id === "lever-high");
  const medium = state.sources.find((source) => source.id === "lever-medium");
  const low = state.sources.find((source) => source.id === "lever-low");
  assert.equal(high.lifecycle, "probed");
  assert.equal(high.reviewStatus, "pending");
  assert.equal(high.collectionEnabled, false);
  assert.equal(medium.lifecycle, "probed");
  assert.equal(medium.reviewStatus, "pending");
  assert.equal(medium.collectionEnabled, false);
  assert.equal(low.lifecycle, "candidate");
  assert.equal(low.reviewStatus, "unreviewed");
  assert.ok(state.sources.every((source) => source.lifecycle !== "approved"));
});

test("a transient probe failure is retried after a 24-hour backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-probe-retry-"));
  let current = new Date("2026-08-20T00:00:00.000Z");
  let fail = true;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (fail) throw Object.assign(new Error("temporary reset"), { code: "ECONNRESET" });
    return new Response(JSON.stringify([{ id: "retry-1", text: "Beijing Engineer", categories: { location: "Beijing, China" }, hostedUrl: "https://jobs.lever.co/retry-probe/retry-1", applyUrl: "https://jobs.lever.co/retry-probe/retry-1/apply" }]), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), now: () => current, fetchOptions: { fetchImpl, skipDns: true } });
  await engine.registry.upsertCandidates({ candidates: [{
    id: "retry-probe",
    sourceKey: "ats:lever:retry-probe",
    name: "Retry Probe",
    provider: "Lever",
    tenant: "retry-probe",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.lever.co/retry-probe",
    publicApiUrl: "https://api.lever.co/v0/postings/retry-probe?mode=json",
    status: "ready_for_probe",
    authority: "employer_controlled_board",
    discoveryPriorityScore: 80,
    queryIds: ["retry"], evidence: [{ channel: "fixture", queryId: "retry" }], discoveredUrls: ["https://jobs.lever.co/retry-probe"], titles: ["Retry Probe"],
    decision: { status: "ready_for_probe", reasonCodes: ["KNOWN_PUBLIC_ATS_PATTERN"], decidedBy: "fixture" },
  }] }, "retry-discovery");
  engine.discoverSources = async () => ({ runId: "empty", discovery: { stats: { candidateSources: 0 } } });

  const first = await engine.runPipeline({ maxQueries: 0, maxProbes: 1 });
  assert.equal(first.probes[0].verificationState, "probe_failed");
  fail = false;
  assert.equal((await engine.runPipeline({ maxQueries: 0, maxProbes: 1 })).probeQueue.selectedSources, 0);
  current = new Date("2026-08-21T01:00:00.000Z");
  const retried = await engine.runPipeline({ maxQueries: 0, maxProbes: 1 });
  assert.equal(retried.probeQueue.selectedSources, 1);
  assert.equal(retried.probes[0].verificationState, "verified");
});

test("NCSS collection paginates until a short terminal page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-ncss-pages-"));
  const offsets = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("offset"));
    offsets.push(offset);
    const count = offset === 1 ? 50 : 1;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = offset + index;
      return { id: `job-${id}`, jobName: `北京岗位 ${id}`, companyName: "分页公司", areaName: "北京", url: `https://job.ncss.cn/jobs/${id}` };
    });
    return new Response(JSON.stringify({ data: { list: rows } }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = {
    id: "ncss-pages",
    sourceKey: "public:ncss:test",
    name: "NCSS 北京岗位",
    provider: "NCSS",
    sourceType: "government_public_employment",
    sourceRootUrl: "https://www.ncss.cn/student/jobs/index.html",
    publicApiUrl: "https://www.ncss.cn/student/jobs/jobslist/ajax/?areaCode=11&offset=1&limit=10",
    scopeSignals: ["北京"],
  };
  await engine.registry.importApprovedSource(candidate);
  const probe = await engine.probeSource({ sourceId: candidate.id });
  assert.equal(probe.probe.http.kind, "http_observation");
  assert.equal(probe.probe.http.status, 200);
  assert.ok(!JSON.stringify(probe).includes("fixture-csrf"));
  assert.ok(!JSON.stringify(probe).includes("fixture-cookie"));
  offsets.length = 0;
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.deepEqual(offsets, [1, 51]);
  assert.equal(result.stats.jobsObserved, 51);
  assert.equal(result.results[0].pagination.complete, true);
  assert.equal(result.results[0].pagination.stopReason, "short_terminal_page");
});

test("ByteDance collection uses the public read-only POST contract and paginates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-bytedance-pages-"));
  const offsets = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url === "https://jobs.bytedance.com/api/v1/csrf/token") {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { portal_entrance: 1 });
      return new Response(JSON.stringify({ code: 0, data: { token: "fixture-csrf" } }), {
        headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=fixture-cookie; Path=/; Secure" },
      });
    }
    assert.equal(url, "https://jobs.bytedance.com/api/v1/search/job/posts");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("portal-channel"), "office");
    assert.equal(options.headers.get("x-csrf-token"), "fixture-csrf");
    assert.equal(options.headers.get("cookie"), "atsx-csrf-token=fixture-cookie");
    const body = JSON.parse(options.body);
    offsets.push(body.offset);
    // Simulate an upstream that clamps the requested limit=100 to ten rows.
    // The next offset must advance by observed rows, never by the request size.
    const count = body.offset < 20 ? 10 : 1;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = body.offset + index + 1;
      return { id: String(id), title: `字节后端工程师 ${id}`, city_info: { name: id % 2 ? "北京" : "湖北省武汉市" } };
    });
    return new Response(JSON.stringify({ code: 0, data: { count: 21, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = {
    id: "bytedance-official-careers",
    sourceKey: "career:bytedance:jobs.bytedance.com",
    name: "字节跳动官方招聘",
    publisher: "字节跳动",
    provider: "ByteDance",
    tenant: "bytedance",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.bytedance.com/experienced/position",
    publicApiUrl: "https://jobs.bytedance.com/api/v1/search/job/posts",
    scopeSignals: ["全国"],
  };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.deepEqual(offsets, [0, 10, 20]);
  assert.equal(result.stats.jobsObserved, 21);
  assert.equal(result.results[0].pagination.complete, true);
  assert.equal(result.results[0].pagination.stopReason, "advertised_total_reached");
  assert.equal(result.results[0].pagination.advertisedTotal, 21);
  assert.ok(!JSON.stringify(result).includes("fixture-csrf"));
  assert.ok(!JSON.stringify(result).includes("fixture-cookie"));
  const persistedRun = await engine.getRun(result.runId);
  assert.equal(persistedRun.output.collectionEvidence[0].pagination.advertisedTotal, 21);
  assert.equal(persistedRun.output.collectionEvidence[0].pagination.complete, true);
  assert.ok(!JSON.stringify(persistedRun).includes("fixture-csrf"));
  assert.ok(!JSON.stringify(persistedRun).includes("fixture-cookie"));
});

test("Feishu Recruitment uses its SaaS public portal contract and canonical detail route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-feishu-pages-"));
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/v1/csrf/token")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.get("portal-channel"), "saas-career");
      assert.equal(options.body, undefined);
      return new Response(JSON.stringify({ code: 0, data: { token: "feishu-fixture-token" } }), { headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=feishu-fixture-cookie; Secure" } });
    }
    assert.equal(options.headers.get("portal-channel"), "saas-career");
    const body = JSON.parse(options.body);
    assert.equal(body.portal_type, 6);
    assert.equal(Object.hasOwn(body, "portal_entrance"), false);
    return new Response(JSON.stringify({ code: 0, data: { count: 1, job_post_list: [{ id: "7501226117869668619", title: "区域官方主播", city_list: [{ name: "北京" }] }] } }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const candidate = {
    id: "feishu-nio",
    sourceKey: "ats:feishu:nio.jobs.feishu.cn",
    name: "NIO 蔚来招聘",
    publisher: "NIO 蔚来",
    provider: "FeishuRecruitment",
    tenant: "nio",
    sourceType: "official_ats",
    sourceRootUrl: "https://nio.jobs.feishu.cn/index",
    publicApiUrl: "https://nio.jobs.feishu.cn/api/v1/search/job/posts",
    scopeSignals: ["全国"],
  };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.equal(result.stats.jobsObserved, 1);
  assert.equal(result.results[0].parser, "feishu_recruitment_public_search_api");
  assert.equal(result.results[0].jobs[0].applyUrl, "https://nio.jobs.feishu.cn/index/position/7501226117869668619/detail");
  assert.ok(!JSON.stringify(result).includes("feishu-fixture-token"));
  assert.ok(!JSON.stringify(result).includes("feishu-fixture-cookie"));
});

test("a non-zero public recruitment business code can never verify stale rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-public-search-business-error-"));
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/v1/csrf/token")) return new Response(JSON.stringify({ code: 0, data: { token: "business-token" } }), { headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=business-cookie; Secure" } });
    return new Response(JSON.stringify({ code: -9000003, data: { count: 1, job_post_list: [{ id: "stale", title: "北京工程师", city_info: { name: "北京" } }] } }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const candidate = { id: "business-error", sourceKey: "career:bytedance:jobs.bytedance.com", name: "字节跳动官方招聘", publisher: "字节跳动", provider: "ByteDance", tenant: "bytedance", sourceType: "official_ats", sourceRootUrl: "https://jobs.bytedance.com/experienced/position", publicApiUrl: "https://jobs.bytedance.com/api/v1/search/job/posts", scopeSignals: ["全国"] };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.probeSource({ sourceId: candidate.id });
  assert.equal(result.probe.verificationState, "upstream_error");
  assert.equal(result.probe.collectable, false);
  assert.equal((await engine.registry.snapshot()).sources[0].collectionEnabled, false);
});

test("an advertised ByteDance total gap remains incomplete and cannot advance missing jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-bytedance-gap-"));
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/v1/csrf/token")) return new Response(JSON.stringify({ code: 0, data: { token: "gap-token" } }), { headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=gap-cookie; Secure" } });
    searchCalls += 1;
    const rows = searchCalls === 1
      ? [{ id: "1", title: "北京工程师 1", city_info: { name: "北京" } }, { id: "2", title: "北京工程师 2", city_info: { name: "北京" } }]
      : [];
    return new Response(JSON.stringify({ code: 0, data: { count: 3, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const candidate = { id: "bytedance-gap", sourceKey: "career:bytedance:jobs.bytedance.com", name: "字节跳动官方招聘", publisher: "字节跳动", provider: "ByteDance", tenant: "bytedance", sourceType: "official_ats", sourceRootUrl: "https://jobs.bytedance.com/experienced/position", publicApiUrl: "https://jobs.bytedance.com/api/v1/search/job/posts", scopeSignals: ["全国"] };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.equal(result.results[0].pagination.complete, false);
  assert.equal(result.results[0].pagination.stopReason, "advertised_total_gap");
  assert.equal(result.results[0].pagination.advertisedTotal, 3);
  assert.equal(result.results[0].storage.missingAdvanceSuppressed, true);
});

test("ByteDance collection refreshes an expired anonymous session only once and never persists it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-bytedance-csrf-fail-"));
  let sessionCalls = 0;
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/v1/csrf/token")) {
      sessionCalls += 1;
      return new Response(JSON.stringify({ code: 0, data: { token: `secret-session-${sessionCalls}` } }), {
        headers: { "content-type": "application/json", "set-cookie": `atsx-csrf-token=secret-cookie-${sessionCalls}; Secure` },
      });
    }
    searchCalls += 1;
    return new Response(JSON.stringify({ code: -1, message: "expired" }), { status: 405, headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({ projectRoot, registryPath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts"), fetchOptions: { fetchImpl, skipDns: true } });
  const candidate = {
    id: "bytedance-csrf-failure",
    sourceKey: "career:bytedance:jobs.bytedance.com",
    name: "字节跳动官方招聘",
    publisher: "字节跳动",
    provider: "ByteDance",
    tenant: "bytedance",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.bytedance.com/experienced/position",
    publicApiUrl: "https://jobs.bytedance.com/api/v1/search/job/posts",
    scopeSignals: ["全国"],
  };
  await engine.registry.importApprovedSource(candidate);
  await assert.rejects(() => engine.collectJobs({ sourceId: candidate.id, commit: false }), (error) => error.code === "COLLECTION_HTTP_ERROR");
  assert.equal(sessionCalls, 2);
  assert.equal(searchCalls, 2);
  const stateText = await readFile(join(directory, "state.json"), "utf8");
  assert.ok(!stateText.includes("secret-session"));
  assert.ok(!stateText.includes("secret-cookie"));
});

test("collection retries one transient network failure without weakening safety checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-transient-retry-"));
  let apiAttempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    apiAttempts += 1;
    if (apiAttempts === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return new Response(JSON.stringify([{
      id: "retry-job",
      text: "Beijing Reliability Engineer",
      categories: { location: "Beijing, China" },
      hostedUrl: "https://jobs.lever.co/retry-company/retry-job",
      applyUrl: "https://jobs.lever.co/retry-company/retry-job/apply",
    }]), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = {
    id: "lever-retry-company",
    sourceKey: "ats:lever:retry-company",
    name: "Retry Company",
    provider: "Lever",
    tenant: "retry-company",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.lever.co/retry-company",
    publicApiUrl: "https://api.lever.co/v0/postings/retry-company?mode=json",
    scopeSignals: ["北京"],
  };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.equal(apiAttempts, 2);
  assert.equal(result.stats.jobsObserved, 1);
});

test("Greenhouse collection forces the bounded listing payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-greenhouse-bounded-"));
  let requestedUrl = null;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    requestedUrl = url;
    return new Response(JSON.stringify({ jobs: [] }), { headers: { "content-type": "application/json" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = {
    id: "greenhouse-bounded",
    sourceKey: "ats:greenhouse:bounded",
    name: "Bounded Board",
    provider: "Greenhouse",
    sourceType: "official_ats",
    sourceRootUrl: "https://job-boards.greenhouse.io/bounded",
    publicApiUrl: "https://boards-api.greenhouse.io/v1/boards/bounded/jobs?content=true",
    scopeSignals: ["全国"],
  };
  await engine.registry.importApprovedSource(candidate);
  await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.equal(new URL(requestedUrl).searchParams.get("content"), "false");
});

test("due collection safety-downgrades a source whose robots policy requires authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-robots-downgrade-"));
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("authentication required", { status: 401, headers: { "content-type": "text/plain" } });
    throw new Error(`unexpected fixture URL ${url}`);
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = {
    id: "lever-robots-auth",
    sourceKey: "ats:lever:robots-auth",
    name: "Robots Auth Board",
    provider: "Lever",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.lever.co/robots-auth",
    publicApiUrl: "https://api.lever.co/v0/postings/robots-auth?mode=json",
    scopeSignals: ["全国"],
  };
  await engine.registry.importApprovedSource(candidate);
  const result = await engine.runDue({ commitApproved: true, maxQueries: 0, maxProbes: 0, maxCollections: 1 });
  assert.equal(result.collection.failedSources, 0);
  assert.equal(result.collection.safetyDowngradedSources, 1);
  const source = (await engine.registry.snapshot()).sources.find((item) => item.id === candidate.id);
  assert.equal(source.lifecycle, "probed");
  assert.equal(source.verificationState, "access_restricted");
  assert.equal(source.collectionEnabled, false);
  assert.equal(source.probe.robots.status, 401);
  assert.equal(source.probe.evidence[0].kind, "robots");
});

test("non-authoritative HTML listings ingest jobs but never advance missing counters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-html-missing-"));
  let includeSecond = true;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><title>北京招聘</title><a href="/jobs/one">北京工程师岗位</a>${includeSecond ? '<a href="/jobs/two">北京运营岗位</a>' : ""}</html>`, { headers: { "content-type": "text/html" } });
  };
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    fetchOptions: { fetchImpl, skipDns: true },
  });
  const candidate = { id: "html-list", sourceKey: "html:list", name: "北京招聘栏目", sourceType: "company_career_site", sourceRootUrl: "https://jobs.example.com/beijing", scopeSignals: ["北京"] };
  await engine.registry.importApprovedSource(candidate);
  await engine.collectJobs({ sourceId: candidate.id, commit: true });
  includeSecond = false;
  await engine.collectJobs({ sourceId: candidate.id, commit: true });
  await engine.collectJobs({ sourceId: candidate.id, commit: true });
  const jobs = (await engine.registry.snapshot()).jobs;
  const second = jobs.find((job) => job.applyUrl.endsWith("/jobs/two"));
  assert.equal(second.status, "needs_review");
  assert.equal(second.sourceObservations[candidate.id].consecutiveMissing, 1);
  assert.equal(second.sourceObservations[candidate.id].missingMode, "review_only");
});

test("approved source collection cadence uses persisted nextDueAt", () => {
  const source = { id: "ats", candidate: { sourceType: "official_ats" }, collection: null };
  assert.equal(collectionDueState(source, new Date("2026-08-20T00:00:00.000Z")).due, true);
  source.collection = { nextDueAt: "2026-08-20T06:00:00.000Z" };
  assert.equal(collectionDueState(source, new Date("2026-08-20T05:59:59.000Z")).due, false);
  assert.equal(collectionDueState(source, new Date("2026-08-20T06:00:00.000Z")).due, true);
  assert.equal(collectionDueState(source, new Date("2026-08-20T06:00:00.000Z")).cadenceHours, 6);
});

test("scheduler evidence requires the current GitHub run and post-pipeline stage", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "run-42" };
  const observation = { trigger: "github_actions", stage: "post_pipeline_finalization", runId: "run-42", scheduledDate: "2026-08-21" };
  assert.equal(schedulerObservationIsLive(observation, env), true);
  assert.equal(schedulerObservationIsLive({ ...observation, runId: "other" }, env), false);
  assert.equal(schedulerObservationIsLive({ ...observation, stage: "starting" }, env), false);
  assert.equal(schedulerObservationIsLive(observation, { ...env, GITHUB_ACTIONS: "false" }), false);
});

test("portable reads close a job after validThrough even without another collection", () => {
  const job = { id: "expired", status: "confirmed_active", validThrough: "2026-08-19T23:59:59.999Z", activeScore: 98 };
  const effective = jobWithEffectiveValidity(job, new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(effective.status, "closed");
  assert.equal(effective.activeScore, 0);
});

test("portable Agent reads always project fields from the selected active source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-list-projection-"));
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
  });
  const source = (id) => ({ id, sourceKey: `source:${id}`, name: id, sourceType: "company_career_site", sourceRootUrl: `https://${id}.example.com/jobs` });
  await engine.registry.importApprovedSource(source("primary"));
  await engine.registry.importApprovedSource(source("secondary"));
  const shared = { id: "shared", company: "示例公司", title: "主来源标题", location: "北京", status: "confirmed_active", contentHash: "shared", evidence: [{ kind: "test" }], applyUrl: "https://apply.example.com/shared" };
  await engine.registry.storeJobs("primary", [{ ...shared, sourceId: "primary", sourceUrl: "https://primary.example.com/jobs/shared" }], { commit: true });
  await engine.registry.storeJobs("secondary", [{ ...shared, id: "secondary-shared", sourceId: "secondary", sourceUrl: "https://secondary.example.com/jobs/shared", title: "次来源标题" }], { commit: true });
  await engine.registry.transaction((state) => {
    state.jobs[0].sourceUrl = "https://secondary.example.com/jobs/shared";
    state.jobs[0].title = "被污染的次来源标题";
  });
  const listed = await engine.listJobs({});
  assert.equal(listed.jobs[0].sourceId, "primary");
  assert.equal(listed.jobs[0].sourceUrl, "https://primary.example.com/jobs/shared");
  assert.equal(listed.jobs[0].title, "主来源标题");
});

test("portable Agent keeps a canonical job visible through a still-valid secondary support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-list-valid-support-"));
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const source = (id) => ({ id, sourceKey: `source:${id}`, name: id, sourceType: "company_career_site", sourceRootUrl: `https://${id}.example.com/jobs` });
  await engine.registry.importApprovedSource(source("primary"));
  await engine.registry.importApprovedSource(source("secondary"));
  const shared = { company: "示例公司", title: "工程师", location: "北京", status: "confirmed_active", contentHash: "shared", evidence: [{ kind: "test" }], applyUrl: "https://apply.example.com/shared" };
  await engine.registry.storeJobs("primary", [{ ...shared, id: "shared", sourceId: "primary", sourceUrl: "https://primary.example.com/jobs/shared", validThrough: "2026-08-21T23:59:59.999Z" }], { commit: true });
  await engine.registry.storeJobs("secondary", [{ ...shared, id: "secondary-shared", sourceId: "secondary", sourceUrl: "https://secondary.example.com/jobs/shared", title: "工程师！", activeScore: 98 }], { commit: true });
  const listed = await engine.listJobs({});
  assert.equal(listed.total, 1);
  assert.equal(listed.jobs[0].sourceId, "secondary");
  assert.equal(listed.jobs[0].sourceUrl, "https://secondary.example.com/jobs/shared");
  assert.equal(listed.jobs[0].title, "工程师！");
  assert.equal(listed.jobs[0].status, "needs_review");
  assert.equal(listed.jobs[0].validThrough, null);
});
