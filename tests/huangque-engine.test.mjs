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
  const result = await engine.collectJobs({ sourceId: candidate.id, commit: false });
  assert.deepEqual(offsets, [1, 51]);
  assert.equal(result.stats.jobsObserved, 51);
  assert.equal(result.results[0].pagination.complete, true);
  assert.equal(result.results[0].pagination.stopReason, "short_terminal_page");
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
