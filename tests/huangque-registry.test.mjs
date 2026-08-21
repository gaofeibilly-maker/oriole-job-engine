import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonRegistry } from "../scripts/huangque/lib/registry.mjs";

function candidate(id) {
  return {
    id,
    sourceKey: `source:${id}`,
    name: id,
    sourceRootUrl: `https://${id}.example.com/jobs`,
    sourceType: "company_career_site",
  };
}

test("file lock preserves updates from independent registry instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-lock-"));
  const path = join(directory, "state.json");
  const left = new JsonRegistry(path);
  const right = new JsonRegistry(path);
  await Promise.all([
    left.upsertCandidates({ candidates: [candidate("left")] }),
    right.upsertCandidates({ candidates: [candidate("right")] }),
  ]);
  const state = await left.snapshot();
  assert.deepEqual(state.sources.map((source) => source.id).sort(), ["left", "right"]);
});

test("an unverified rediscovery cannot replace the evidence carried by a verified graph edge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-edge-evidence-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  const verified = {
    ...candidate("one"),
    publisher: "Example Publisher",
    regions: [{ countryCode: "CN", provinceCode: "420000", provinceName: "湖北省", cityCode: "420100", cityName: "武汉市", label: "湖北省-武汉市" }],
    evidence: [{ channel: "verified_snapshot", url: "https://one.example.com/jobs" }],
  };
  await registry.importApprovedSource(verified);
  await registry.upsertCandidates({ candidates: [{ ...verified, evidence: [{ channel: "weak_search", query: "武汉招聘", url: "https://one.example.com/jobs" }] }] }, "run-weak");
  const state = await registry.snapshot();
  const edge = state.edges.find((item) => item.type === "covers_region");
  assert.equal(edge.verificationState, "verified");
  assert.equal(edge.evidence.observation.channel, "verified_snapshot");
  assert.equal(edge.latestObservation.observation.channel, "weak_search");
});

test("registry validation prunes a stale publisher relation even when a source is not re-imported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-stale-publisher-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  await registry.importApprovedSource({ ...candidate("publisher"), publisher: "Current Publisher" });
  await registry.transaction((state) => {
    const current = state.edges.find((edge) => edge.type === "published_by");
    state.edges.push({
      ...current,
      id: "legacy-edge",
      key: `${current.from}\0published_by\0publisher:Legacy Publisher`,
      to: "publisher:Legacy Publisher",
    });
  });
  const relations = (await registry.snapshot()).edges.filter((edge) => edge.type === "published_by");
  assert.deepEqual(relations.map((edge) => edge.to), ["publisher:Current Publisher"]);
});

test("a live long transaction cannot be stolen as stale and release is ownership-safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-lock-lease-"));
  const path = join(directory, "state.json");
  const left = new JsonRegistry(path);
  const right = new JsonRegistry(path);
  const slow = left.transaction(async (state) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 70));
    state.events.push({ id: "slow", type: "test" });
  }, { staleMs: 20, timeoutMs: 250 });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
  const fast = right.transaction((state) => {
    state.events.push({ id: "fast", type: "test" });
  }, { staleMs: 20, timeoutMs: 250 });
  await Promise.all([slow, fast]);
  const state = await left.snapshot();
  assert.deepEqual(state.events.map((event) => event.id).sort(), ["fast", "slow"]);
});

test("registry persists cross-source exact merge and soft duplicate review candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-dedupe-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["one", "two"]) await registry.importApprovedSource(candidate(id));
  const base = {
    company: "示例公司",
    title: "运营经理",
    location: "北京",
    status: "confirmed_active",
    evidence: [{ kind: "test" }],
    contentHash: "hash",
  };
  await registry.storeJobs("one", [{ ...base, id: "job-one", sourceId: "one", applyUrl: "https://jobs.example.com/apply/shared", sourceUrl: "https://one.example.com/jobs/1" }], { commit: true });
  await registry.storeJobs("two", [{ ...base, id: "job-two", sourceId: "two", applyUrl: "https://jobs.example.com/apply/shared?utm_source=two", sourceUrl: "https://two.example.com/jobs/2" }], { commit: true });
  let state = await registry.snapshot();
  assert.equal(state.jobs.length, 1);
  assert.deepEqual(state.jobs[0].sourceIds.sort(), ["one", "two"]);
  assert.deepEqual(state.edges.filter((edge) => edge.type === "lists_job").map((edge) => edge.to), ["job:job-one", "job:job-one"]);
  assert.ok(state.edges.filter((edge) => edge.type === "lists_job").every((edge) => state.jobs.some((job) => edge.to === `job:${job.id}`)));

  await registry.storeJobs("two", [{ ...base, id: "job-soft", sourceId: "two", applyUrl: "https://jobs.example.com/apply/different", sourceUrl: "https://two.example.com/jobs/3", contentHash: "other" }], { commit: true });
  state = await registry.snapshot();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.duplicateCandidates.length, 1);
  assert.equal(state.duplicateCandidates[0].action, "review_only_not_auto_merged");
});

test("registry never exact-merges distinct jobs that only share a source-list fallback URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-fallback-url-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  await registry.importApprovedSource(candidate("one"));
  const fallback = "https://one.example.com/jobs";
  const base = { sourceId: "one", company: "示例单位", location: "北京", status: "confirmed_active", evidence: [{ kind: "test" }], sourceUrl: fallback, applyUrl: fallback, urlIdentity: "source_fallback" };
  await registry.storeJobs("one", [
    { ...base, id: "job-one", externalId: "one", title: "岗位一", contentHash: "hash-one" },
    { ...base, id: "job-two", externalId: "two", title: "岗位二", contentHash: "hash-two" },
  ], { commit: true });
  const state = await registry.snapshot();
  assert.equal(state.jobs.length, 2);
  assert.deepEqual(state.jobs.map((job) => job.externalId).sort(), ["one", "two"]);
});

test("a cross-source exact job closes only after every source reaches its own missing threshold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-multi-source-expiry-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["one", "two"]) await registry.importApprovedSource(candidate(id));
  const shared = { id: "shared", company: "示例公司", title: "工程师", location: "北京", status: "confirmed_active", contentHash: "shared", evidence: [{ kind: "test" }], applyUrl: "https://jobs.example.com/apply/shared", sourceUrl: "https://jobs.example.com/shared" };
  await registry.storeJobs("one", [{ ...shared, sourceId: "one", sourceUrl: "https://one.example.com/jobs/shared" }], { commit: true });
  await registry.storeJobs("two", [{ ...shared, id: "shared-two", sourceId: "two", sourceUrl: "https://two.example.com/jobs/shared" }], { commit: true });
  const replacement = (sourceId) => [{ ...shared, id: `replacement-${sourceId}`, sourceId, title: `其他岗位 ${sourceId}`, contentHash: `replacement-${sourceId}`, applyUrl: `https://jobs.example.com/apply/${sourceId}` }];
  await registry.storeJobs("one", replacement("one"), { commit: true });
  await registry.storeJobs("one", replacement("one"), { commit: true });
  let job = (await registry.snapshot()).jobs.find((item) => item.id === "shared");
  assert.equal(job.status, "confirmed_active");
  assert.equal(job.sourceObservations.one.consecutiveMissing, 2);
  assert.equal(job.sourceObservations.two.consecutiveMissing, 0);
  await registry.storeJobs("two", replacement("two"), { commit: true });
  job = (await registry.snapshot()).jobs.find((item) => item.id === "shared");
  assert.equal(job.status, "needs_review");
  await registry.storeJobs("two", replacement("two"), { commit: true });
  job = (await registry.snapshot()).jobs.find((item) => item.id === "shared");
  assert.equal(job.status, "closed");
});

test("rejecting one support removes its observations and recomputes status from remaining sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-reject-support-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["one", "two"]) await registry.importApprovedSource(candidate(id));
  const shared = { id: "shared", company: "示例公司", title: "工程师", location: "北京", status: "confirmed_active", contentHash: "shared", evidence: [{ kind: "test" }], applyUrl: "https://jobs.example.com/apply/shared", sourceUrl: "https://jobs.example.com/shared" };
  await registry.storeJobs("one", [{ ...shared, sourceId: "one", sourceUrl: "https://one.example.com/jobs/shared" }], { commit: true });
  await registry.storeJobs("two", [{ ...shared, id: "shared-two", sourceId: "two", sourceUrl: "https://two.example.com/jobs/shared" }], { commit: true });
  const replacement = [{ ...shared, id: "replacement", sourceId: "two", title: "其他岗位", contentHash: "replacement", applyUrl: "https://jobs.example.com/apply/replacement" }];
  await registry.storeJobs("two", replacement, { commit: true });
  await registry.storeJobs("two", replacement, { commit: true });
  const source = (await registry.snapshot()).sources.find((item) => item.id === "one");
  await registry.reviewSource("one", { decision: "reject", reason: "来源撤销", reviewedBy: "tester", expectedRevision: source.revision, confirmation: true });
  const job = (await registry.snapshot()).jobs.find((item) => item.id === "shared");
  assert.deepEqual(job.sourceIds, ["two"]);
  assert.equal(job.sourceObservations.one, undefined);
  assert.equal(job.sourceId, "two");
  assert.equal(job.sourceUrl, "https://two.example.com/jobs/shared");
  assert.equal(job.status, "closed");
});

test("rejecting a secondary last writer restores the unchanged primary source projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-reject-secondary-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["primary", "secondary"]) await registry.importApprovedSource(candidate(id));
  const shared = { id: "shared", company: "示例公司", title: "工程师", location: "北京", status: "confirmed_active", contentHash: "shared", evidence: [{ kind: "test" }], applyUrl: "https://jobs.example.com/apply/shared" };
  await registry.storeJobs("primary", [{ ...shared, sourceId: "primary", sourceUrl: "https://primary.example.com/jobs/shared", title: "主来源标题" }], { commit: true });
  await registry.storeJobs("secondary", [{ ...shared, id: "shared-secondary", sourceId: "secondary", sourceUrl: "https://secondary.example.com/jobs/shared", title: "次来源标题" }], { commit: true });
  let job = (await registry.snapshot()).jobs[0];
  assert.equal(job.sourceId, "primary");
  assert.equal(job.sourceUrl, "https://primary.example.com/jobs/shared");
  assert.equal(job.title, "主来源标题");
  const source = (await registry.snapshot()).sources.find((item) => item.id === "secondary");
  await registry.reviewSource("secondary", { decision: "reject", reason: "来源撤销", reviewedBy: "tester", expectedRevision: source.revision, confirmation: true });
  job = (await registry.snapshot()).jobs[0];
  assert.deepEqual(job.sourceIds, ["primary"]);
  assert.equal(job.sourceId, "primary");
  assert.equal(job.sourceUrl, "https://primary.example.com/jobs/shared");
  assert.equal(job.title, "主来源标题");
});

test("repeated secondary observations do not create false canonical content versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-secondary-version-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["primary", "secondary"]) await registry.importApprovedSource(candidate(id));
  const shared = { id: "shared", company: "示例公司", title: "工程师", location: "北京", status: "confirmed_active", evidence: [{ kind: "test" }], applyUrl: "https://jobs.example.com/apply/shared" };
  await registry.storeJobs("primary", [{ ...shared, sourceId: "primary", sourceUrl: "https://primary.example.com/jobs/shared", contentHash: "hash-primary" }], { commit: true });
  const secondary = [{ ...shared, id: "shared-secondary", sourceId: "secondary", sourceUrl: "https://secondary.example.com/jobs/shared", contentHash: "hash-secondary" }];
  await registry.storeJobs("secondary", secondary, { commit: true });
  await registry.storeJobs("secondary", secondary, { commit: true });
  let state = await registry.snapshot();
  assert.equal(state.jobs[0].sourceId, "primary");
  assert.equal(state.jobs[0].contentHash, "hash-primary");
  assert.equal(state.jobs[0].version, 1);
  assert.equal(state.jobVersions.length, 1);
  await registry.storeJobs("primary", [{ ...shared, sourceId: "primary", sourceUrl: "https://primary.example.com/jobs/shared", title: "高级工程师", contentHash: "hash-primary-v2" }], { commit: true });
  state = await registry.snapshot();
  assert.equal(state.jobs[0].version, 2);
  assert.equal(state.jobs[0].contentHash, "hash-primary-v2");
  assert.equal(state.jobVersions.length, 2);
});

test("discovery progress completes a bucket only after all plan tasks succeed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-query-progress-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `bucket:${index + 1}`, bucketId: "bucket" }));
  let output = await registry.updateDiscoveryProgress(["bucket:1", "bucket:2"], tasks, "run-one");
  assert.deepEqual(output.completedBucketIds, []);
  assert.deepEqual(output.bucketState.bucket.completedTaskIds, ["bucket:1", "bucket:2"]);
  output = await registry.updateDiscoveryProgress(["bucket:3", "bucket:4"], tasks, "run-two");
  assert.deepEqual(output.completedBucketIds, ["bucket"]);
  assert.deepEqual(output.bucketState.bucket.completedTaskIds, []);
  assert.ok(output.bucketState.bucket.lastCompletedAt);
});

test("one expired source cannot close a canonical job still active at another source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-validity-conflict-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  for (const id of ["active", "expired"]) await registry.importApprovedSource(candidate(id));
  const base = { company: "示例公司", title: "工程师", location: "北京", evidence: [{ kind: "test" }], applyUrl: "https://jobs.example.com/apply/shared", sourceUrl: "https://jobs.example.com/shared", contentHash: "shared" };
  await registry.storeJobs("active", [{ ...base, id: "active-job", sourceId: "active", status: "confirmed_active", activeScore: 98 }], { commit: true });
  await registry.storeJobs("expired", [{ ...base, id: "expired-job", sourceId: "expired", status: "closed", activeScore: 0, validThrough: "2026-08-19T23:59:59.999Z" }], { commit: true });
  const job = (await registry.snapshot()).jobs[0];
  assert.equal(job.status, "needs_review");
  assert.equal(job.validThrough, null);
  assert.equal(job.activeScore, 98);
  assert.equal(job.freshnessState, "source_validity_conflict");
});
