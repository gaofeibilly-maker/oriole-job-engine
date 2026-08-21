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

const cursorFingerprint = `sha256:${"a".repeat(64)}`;

function offsetCandidate(id, provider = "ByteDance") {
  return {
    ...candidate(id),
    provider,
    publicApiUrl: `https://${id}.example.com/api/v1/search/job/posts`,
  };
}

function checkpoint({ fingerprint = cursorFingerprint, generation, startOffset, nextOffset, cycleEndReached = false, headRefreshRows = 100, tailRowsObserved = 4_900 }) {
  return {
    schemaVersion: "huangque.collection-resume.v1",
    fingerprint,
    generation,
    startOffset,
    nextOffset,
    cycleEndReached,
    headRefreshRows,
    tailRowsObserved,
  };
}

function sourceJob(sourceId, externalId) {
  return {
    id: `${sourceId}-${externalId}`,
    sourceId,
    externalId,
    company: "示例公司",
    title: `岗位 ${externalId}`,
    location: "北京",
    status: "confirmed_active",
    evidence: [{ kind: "test" }],
    sourceUrl: `https://${sourceId}.example.com/jobs/${externalId}`,
    applyUrl: `https://${sourceId}.example.com/jobs/${externalId}`,
    contentHash: `hash-${externalId}`,
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

test("concurrent segments use cursor CAS so a loser cannot half-commit jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-cursor-cas-"));
  const path = join(directory, "state.json");
  const left = new JsonRegistry(path);
  const right = new JsonRegistry(path);
  await left.importApprovedSource(offsetCandidate("racing"));
  const options = {
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 0, startOffset: 0, nextOffset: 100, tailRowsObserved: 200 }),
  };
  const settled = await Promise.allSettled([
    left.storeJobs("racing", [sourceJob("racing", "left")], options),
    right.storeJobs("racing", [sourceJob("racing", "right")], options),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "COLLECTION_CHECKPOINT_CONFLICT");
  const state = await left.snapshot();
  assert.equal(state.sources[0].collection.resume.generation, 1);
  assert.equal(state.sources[0].collection.resume.nextOffset, 100);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.events.filter((event) => event.type === "jobs_collected").length, 1);
});

test("source revision CAS rejects preview and commit after an approved endpoint changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-revision-cas-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  const original = offsetCandidate("revision-race");
  await registry.importApprovedSource(original);
  const expectedSourceRevision = (await registry.snapshot()).sources[0].revision;
  const changedEndpoint = "https://revision-race.example.com/api/v2/search/job/posts";
  await registry.importApprovedSource({ ...original, publicApiUrl: changedEndpoint });
  const options = {
    expectedSourceRevision,
    collectionCheckpoint: checkpoint({ generation: 0, startOffset: 0, nextOffset: 100, tailRowsObserved: 200 }),
  };

  await assert.rejects(
    () => registry.storeJobs("revision-race", [sourceJob("revision-race", "preview")], { ...options, commit: false }),
    (error) => error.code === "SOURCE_REVISION_CONFLICT"
      && error.expectedSourceRevision === expectedSourceRevision
      && error.actualSourceRevision === expectedSourceRevision + 1,
  );
  await assert.rejects(
    () => registry.storeJobs("revision-race", [sourceJob("revision-race", "commit")], { ...options, commit: true }),
    (error) => error.code === "SOURCE_REVISION_CONFLICT",
  );
  const state = await registry.snapshot();
  assert.equal(state.sources[0].candidate.publicApiUrl, changedEndpoint);
  assert.equal(state.sources[0].collection?.resume, undefined);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.events.some((event) => event.type === "jobs_collected"), false);
});

test("job writes and nested cursor rotation commit atomically while preview and failure never advance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-collection-checkpoint-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  await registry.importApprovedSource(offsetCandidate("segmented"));

  await registry.storeJobs("segmented", [sourceJob("segmented", "first")], {
    runId: "segment-1",
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 0, startOffset: 0, nextOffset: 4_900 }),
  });
  let state = await registry.snapshot();
  let collection = state.sources[0].collection;
  assert.equal(collection.resume.schemaVersion, "huangque.collection-resume.v1");
  assert.equal(collection.resume.generation, 1);
  assert.equal(collection.resume.nextOffset, 4_900);
  assert.equal(collection.resume.cycle.number, 1);
  assert.equal(collection.resume.cycle.segmentsCommitted, 1);
  assert.equal(collection.resume.cycle.completedAt, null);

  await registry.storeJobs("segmented", [sourceJob("segmented", "preview")], {
    runId: "segment-preview",
    commit: false,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 1, startOffset: 4_900, nextOffset: 9_800 }),
  });
  state = await registry.snapshot();
  collection = state.sources[0].collection;
  assert.equal(collection.resume.nextOffset, 4_900);
  assert.equal(collection.resume.generation, 1);
  assert.equal(state.jobs.some((job) => job.externalId === "preview"), false);

  await registry.recordCollectionAttempt("segmented", {
    runId: "segment-failed",
    success: false,
    commit: true,
    error: { code: "COLLECTION_HTTP_ERROR", message: "fixture failure" },
  });
  collection = (await registry.snapshot()).sources[0].collection;
  assert.equal(collection.resume.nextOffset, 4_900);
  assert.equal(collection.resume.generation, 1);

  await registry.storeJobs("segmented", [sourceJob("segmented", "second")], {
    runId: "segment-2",
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 1, startOffset: 4_900, nextOffset: 9_800 }),
  });
  collection = (await registry.snapshot()).sources[0].collection;
  assert.equal(collection.resume.nextOffset, 9_800);
  assert.equal(collection.resume.generation, 2);
  assert.equal(collection.resume.cycle.number, 1);
  assert.equal(collection.resume.cycle.segmentsCommitted, 2);

  await registry.storeJobs("segmented", [sourceJob("segmented", "tail")], {
    runId: "segment-tail",
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 2, startOffset: 9_800, nextOffset: 0, cycleEndReached: true, tailRowsObserved: 200 }),
  });
  state = await registry.snapshot();
  collection = state.sources[0].collection;
  assert.equal(collection.resume.nextOffset, 0);
  assert.equal(collection.resume.generation, 3);
  assert.equal(collection.resume.cycle.number, 1);
  assert.equal(collection.resume.cycle.segmentsCommitted, 3);
  assert.ok(collection.resume.cycle.completedAt);
  assert.equal(collection.resume.cycle.endReason, "source_end_reached");
  assert.deepEqual(collection.resume.segments.map((segment) => segment.startOffset), [0, 4_900, 9_800]);
  assert.equal(state.jobs.find((job) => job.externalId === "first").status, "confirmed_active");
  assert.equal(state.jobs.find((job) => job.externalId === "first").sourceObservations.segmented.consecutiveMissing, 0);
});

test("ordinary sources stay cursor-free while legacy, changed, and malformed cursors reset safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-collection-checkpoint-legacy-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  await registry.importApprovedSource(candidate("ordinary"));
  await registry.storeJobs("ordinary", [sourceJob("ordinary", "one")], { commit: true, runId: "ordinary-run" });
  const ordinary = (await registry.snapshot()).sources.find((source) => source.id === "ordinary").collection;
  assert.equal(Object.hasOwn(ordinary, "resume"), false);

  await registry.importApprovedSource(offsetCandidate("legacy"));
  await registry.transaction((draft) => {
    const source = draft.sources.find((item) => item.id === "legacy");
    source.collection = { resumeOffset: 49_000, cycle: { number: 99 } };
  });
  await registry.storeJobs("legacy", [sourceJob("legacy", "one")], {
    runId: "legacy-segment",
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ generation: 0, startOffset: 0, nextOffset: 100, tailRowsObserved: 200 }),
  });
  let collection = (await registry.snapshot()).sources.find((source) => source.id === "legacy").collection;
  assert.equal(collection.resume.nextOffset, 100);
  assert.equal(collection.resume.generation, 1);
  assert.equal(collection.resume.resetReason, "legacy_checkpoint_replaced");
  assert.equal(Object.hasOwn(collection, "resumeOffset"), false);
  assert.equal(Object.hasOwn(collection, "cycle"), false);

  const changedFingerprint = `sha256:${"b".repeat(64)}`;
  await registry.storeJobs("legacy", [sourceJob("legacy", "two")], {
    runId: "changed-fingerprint",
    commit: true,
    allowMissingAdvance: false,
    collectionCheckpoint: checkpoint({ fingerprint: changedFingerprint, generation: 0, startOffset: 0, nextOffset: 50, tailRowsObserved: 150 }),
  });
  collection = (await registry.snapshot()).sources.find((source) => source.id === "legacy").collection;
  assert.equal(collection.resume.fingerprint, changedFingerprint);
  assert.equal(collection.resume.generation, 1);
  assert.equal(collection.resume.nextOffset, 50);
  assert.equal(collection.resume.resetReason, "fingerprint_changed_or_invalid");

  await assert.rejects(() => registry.storeJobs("legacy", [sourceJob("legacy", "never-written")], {
    commit: true,
    collectionCheckpoint: checkpoint({ fingerprint: changedFingerprint, generation: 1, startOffset: 50, nextOffset: 50_000_001 }),
  }), (error) => error.code === "INVALID_COLLECTION_CHECKPOINT");
  const finalState = await registry.snapshot();
  assert.equal(finalState.sources.find((source) => source.id === "legacy").collection.resume.nextOffset, 50);
  assert.equal(finalState.jobs.some((job) => job.externalId === "never-written"), false);
});

test("unapproved candidate rediscovery accumulates bounded evidence without weakening readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-candidate-merge-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  const strong = {
    ...candidate("merge"),
    status: "ready_for_probe",
    authority: "official_public_service",
    discoveryPriorityScore: 91,
    queryIds: ["strong-query"],
    discoveredUrls: ["https://merge.example.com/jobs"],
    titles: ["强证据招聘入口"],
    evidence: [{ channel: "official_catalog", url: "https://merge.example.com/jobs" }],
    decision: { status: "ready_for_probe", reasonCodes: ["OFFICIAL_DIRECTORY"], decidedBy: "strong_rules" },
    nextAction: "探测官方公开入口",
  };
  await registry.upsertCandidates({ candidates: [strong] }, "run-strong");
  const weak = {
    ...candidate("merge"),
    name: "较弱搜索标题",
    status: "backlog",
    authority: "unknown",
    discoveryPriorityScore: 12,
    queryIds: ["strong-query", ...Array.from({ length: 220 }, (_, index) => `query-${index}`)],
    discoveredUrls: ["https://merge.example.com/jobs", ...Array.from({ length: 120 }, (_, index) => `https://merge.example.com/jobs/${index}`)],
    titles: ["强证据招聘入口", ...Array.from({ length: 60 }, (_, index) => `搜索标题 ${index}`)],
    evidence: [
      { channel: "official_catalog", url: "https://merge.example.com/jobs" },
      ...Array.from({ length: 60 }, (_, index) => ({ channel: "search", queryId: `query-${index}`, url: `https://merge.example.com/jobs/${index}` })),
    ],
    decision: { status: "backlog", reasonCodes: ["WEAK_SEARCH"], decidedBy: "weak_rules" },
    nextAction: "等待更多证据",
  };
  await registry.upsertCandidates({ candidates: [weak] }, "run-weak");

  const source = (await registry.snapshot()).sources.find((item) => item.id === "merge");
  assert.equal(source.lifecycle, "candidate");
  assert.equal(source.candidate.status, "ready_for_probe");
  assert.equal(source.candidate.authority, "official_public_service");
  assert.equal(source.candidate.discoveryPriorityScore, 91);
  assert.equal(source.candidate.decision.status, "ready_for_probe");
  assert.equal(source.candidate.decision.decidedBy, "strong_rules");
  assert.equal(source.candidate.nextAction, "探测官方公开入口");
  assert.deepEqual(source.candidate.decision.reasonCodes.sort(), ["OFFICIAL_DIRECTORY", "WEAK_SEARCH"]);
  assert.equal(source.candidate.queryIds.length, 200);
  assert.equal(source.candidate.evidence.length, 50);
  assert.equal(source.candidate.discoveredUrls.length, 100);
  assert.equal(source.candidate.titles.length, 50);
  assert.equal(new Set(source.candidate.queryIds).size, source.candidate.queryIds.length);
  assert.equal(new Set(source.candidate.discoveredUrls).size, source.candidate.discoveredUrls.length);
  assert.equal(new Set(source.candidate.titles).size, source.candidate.titles.length);
  assert.ok(source.candidate.queryIds.includes("query-219"));
  assert.ok(source.candidate.evidence.some((item) => item.queryId === "query-59"));
});

test("stronger candidate rediscovery upgrades readiness while preserving earlier observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-candidate-upgrade-"));
  const registry = new JsonRegistry(join(directory, "state.json"));
  const weak = {
    ...candidate("upgrade"),
    status: "needs_review",
    authority: "needs_domain_ownership_check",
    discoveryPriorityScore: 35,
    queryIds: ["query-old"],
    discoveredUrls: ["https://upgrade.example.com/jobs"],
    titles: ["旧标题"],
    evidence: [{ channel: "search", queryId: "query-old" }],
    decision: { status: "needs_review", reasonCodes: ["DOMAIN_UNCONFIRMED"], decidedBy: "search_rules" },
  };
  const strong = {
    ...weak,
    status: "ready_for_probe",
    authority: "official_employer",
    discoveryPriorityScore: 88,
    queryIds: ["query-new"],
    titles: ["官方招聘入口"],
    evidence: [{ channel: "official_catalog", queryId: "query-new" }],
    decision: { status: "ready_for_probe", reasonCodes: ["OFFICIAL_EMPLOYER"], decidedBy: "catalog_rules" },
  };
  await registry.upsertCandidates({ candidates: [weak] }, "run-old");
  await registry.upsertCandidates({ candidates: [strong] }, "run-new");
  const merged = (await registry.snapshot()).sources[0].candidate;
  assert.equal(merged.status, "ready_for_probe");
  assert.equal(merged.authority, "official_employer");
  assert.equal(merged.discoveryPriorityScore, 88);
  assert.deepEqual(merged.queryIds, ["query-old", "query-new"]);
  assert.deepEqual(merged.titles, ["旧标题", "官方招聘入口"]);
  assert.equal(merged.evidence.length, 2);
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
