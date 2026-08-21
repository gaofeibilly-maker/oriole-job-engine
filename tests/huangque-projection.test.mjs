import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedProjection, HOSTED_JOB_FRESHNESS_TTL_MS, HOSTED_PROJECTION_LIMITS } from "../scripts/huangque/lib/hosted-projection.mjs";

function job(sourceId, id, { status, activeScore }) {
  return {
    id,
    sourceId,
    sourceIds: [sourceId],
    externalId: id,
    company: "Projection Test",
    title: id,
    location: "北京",
    sourceUrl: `https://source.example.com/jobs/${id}`,
    applyUrl: `https://source.example.com/jobs/${id}`,
    status,
    activeScore,
    authenticityScore: 90,
    observedAt: "2026-08-20T00:00:00.000Z",
    evidence: [{ kind: "test", sourceId }],
  };
}

test("hosted projection never retains lists_job edges for a job removed by limits", () => {
  const sourceId = "approved-source";
  const state = {
    schemaVersion: "huangque.registry.v1",
    revision: 1,
    metadata: { updatedAt: "2026-08-20T00:00:00.000Z" },
    sources: [{
      id: sourceId,
      revision: 1,
      sourceKey: "source:approved",
      name: "Approved source",
      lifecycle: "approved",
      reviewStatus: "approved",
      verificationState: "verified",
      collectionEnabled: true,
      approvedAt: "2026-08-20T00:00:00.000Z",
      candidate: { sourceRootUrl: "https://source.example.com/jobs" },
      probe: { verificationState: "verified" },
      review: { decision: "approve" },
      collection: {
        lastCollectedAt: "2026-08-20T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-08-20T00:01:00.000Z",
        missingAdvanceSuppressed: false,
      },
    }],
    jobs: [
      job(sourceId, "low-priority", { status: "needs_review", activeScore: 10 }),
      job(sourceId, "high-priority", { status: "confirmed_active", activeScore: 99 }),
    ],
    edges: [
      { id: "edge-low", from: sourceId, to: "job:low-priority", type: "lists_job", evidence: { kind: "test" } },
      { id: "edge-high", from: sourceId, to: "job:high-priority", type: "lists_job", evidence: { kind: "test" } },
    ],
    runs: [],
  };
  const projection = buildHostedProjection(state, {
    generatedAt: "2026-08-20T00:00:00.000Z",
    limits: { ...HOSTED_PROJECTION_LIMITS, jobs: 1, edges: 10 },
  });
  assert.deepEqual(projection.jobs.map((item) => item.id), ["high-priority"]);
  assert.deepEqual(projection.edges.filter((edge) => edge.type === "lists_job").map((edge) => edge.to), ["job:high-priority"]);
});

test("hosted projection never advertises needs_review jobs as active listings", () => {
  const sourceId = "approved-source";
  const state = {
    schemaVersion: "huangque.registry.v1",
    revision: 1,
    metadata: { updatedAt: "2026-08-20T00:00:00.000Z" },
    sources: [{
      id: sourceId,
      revision: 1,
      sourceKey: "source:approved",
      name: "Approved source",
      lifecycle: "approved",
      reviewStatus: "approved",
      verificationState: "verified",
      collectionEnabled: true,
      candidate: { sourceRootUrl: "https://source.example.com/jobs" },
    }],
    jobs: [observedJob(sourceId, "review-only", "2026-08-20T00:00:00.000Z")],
    edges: [{ id: "edge-review", from: sourceId, to: "job:review-only", type: "lists_job", evidence: { kind: "test" } }],
    runs: [],
  };
  state.jobs[0].status = "needs_review";
  const projection = buildHostedProjection(state, { generatedAt: "2026-08-20T00:00:00.000Z" });
  assert.equal(projection.jobs.length, 0);
  assert.equal(projection.edges.some((edge) => edge.type === "lists_job"), false);
});

function approvedSource(id, {
  provider = "Lever",
  collection = null,
} = {}) {
  return {
    id,
    revision: 1,
    sourceKey: `source:${id}`,
    name: id,
    lifecycle: "approved",
    reviewStatus: "approved",
    verificationState: "verified",
    collectionEnabled: true,
    approvedAt: "2026-08-01T00:00:00.000Z",
    candidate: { provider, sourceRootUrl: `https://${id}.example.com/jobs` },
    collection,
  };
}

function projectionState(sources, jobs) {
  return {
    schemaVersion: "huangque.registry.v1",
    revision: 1,
    metadata: { updatedAt: "2026-08-21T00:00:00.000Z" },
    sources,
    jobs,
    edges: jobs.map((item) => ({ id: `edge-${item.id}`, from: item.sourceId, to: `job:${item.id}`, type: "lists_job", evidence: { kind: "test" } })),
    runs: [],
  };
}

function observedJob(sourceId, id, lastObservedAt) {
  const value = job(sourceId, id, { status: "confirmed_active", activeScore: 99 });
  value.sourceObservations = {
    [sourceId]: {
      consecutiveMissing: 0,
      lastObservedAt,
      observedStatus: "confirmed_active",
      activeScore: 99,
      projection: { ...value },
    },
  };
  return value;
}

test("cursor sources require a recent observation for each individual job", () => {
  const sourceId = "bytedance-cursor";
  const source = approvedSource(sourceId, {
    provider: "ByteDance",
    collection: {
      lastCollectedAt: "2026-08-21T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-21T00:00:30.000Z",
      missingAdvanceSuppressed: true,
      resume: { schemaVersion: "huangque.collection-resume.v1", generation: 3, nextOffset: 4_800 },
    },
  });
  const stale = observedJob(sourceId, "stale-cursor-job", "2026-08-06T23:59:59.000Z");
  const fresh = observedJob(sourceId, "fresh-cursor-job", "2026-08-20T00:00:00.000Z");
  const projection = buildHostedProjection(projectionState([source], [stale, fresh]), {
    generatedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.deepEqual(projection.jobs.map((item) => item.id), ["fresh-cursor-job"]);
  assert.equal(projection.jobs[0].hostedFreshness.basis, "job_source_observation");
  assert.equal(projection.metadata.hostedProjection.freshnessPolicy.stats.excludedWithoutFreshSupport, 1);
  assert.equal(projection.edges.some((edge) => edge.to === "job:stale-cursor-job"), false);
});

test("a fresh partial cursor run never renews an old unseen job", () => {
  const sourceId = "feishu-partial";
  const source = approvedSource(sourceId, {
    provider: "FeishuRecruitment",
    collection: {
      lastCollectedAt: "2026-08-21T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-21T00:01:00.000Z",
      lastAttemptCommitted: true,
      missingAdvanceSuppressed: true,
      resume: { schemaVersion: "huangque.collection-resume.v1", generation: 9, nextOffset: 9_600 },
    },
  });
  const oldJob = observedJob(sourceId, "old-unseen-job", "2026-07-01T00:00:00.000Z");
  const projection = buildHostedProjection(projectionState([source], [oldJob]), {
    generatedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.equal(projection.jobs.length, 0);
  assert.equal(projection.metadata.hostedProjection.freshnessPolicy.stats.excludedWithoutFreshSupport, 1);
});

test("a recent committed HTTP 304 proves a non-cursor source remains fresh", () => {
  const sourceId = "conditional-full-source";
  const source = approvedSource(sourceId, {
    collection: {
      lastSuccessfulCheckAt: "2026-08-20T12:00:00.000Z",
      lastNotModifiedAt: "2026-08-20T12:00:00.000Z",
      httpValidator: { schemaVersion: "huangque.http-validator.v1", status: 304 },
    },
  });
  const oldJob = observedJob(sourceId, "unchanged-job", "2026-07-01T00:00:00.000Z");
  const projection = buildHostedProjection(projectionState([source], [oldJob]), {
    generatedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.deepEqual(projection.jobs.map((item) => item.id), ["unchanged-job"]);
  assert.equal(projection.jobs[0].hostedFreshness.basis, "source_http_304");
});

test("a recent authoritative full collection can renew a non-cursor source", () => {
  const sourceId = "authoritative-full-source";
  const source = approvedSource(sourceId, {
    collection: {
      lastCollectedAt: "2026-08-20T12:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-20T12:02:00.000Z",
      lastAttemptCommitted: true,
      missingAdvanceSuppressed: false,
    },
  });
  const oldJob = observedJob(sourceId, "full-feed-job", "2026-07-01T00:00:00.000Z");
  const projection = buildHostedProjection(projectionState([source], [oldJob]), {
    generatedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.deepEqual(projection.jobs.map((item) => item.id), ["full-feed-job"]);
  assert.equal(projection.jobs[0].hostedFreshness.basis, "source_authoritative_full_collection");
});

test("active jobs without fresh per-job or source-wide evidence fail closed", () => {
  const sourceId = "stale-full-source";
  const source = approvedSource(sourceId, {
    collection: {
      lastCollectedAt: "2026-08-01T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-01T00:01:00.000Z",
      missingAdvanceSuppressed: false,
    },
  });
  const stale = observedJob(sourceId, "stale-full-job", "2026-08-01T00:00:00.000Z");
  const projection = buildHostedProjection(projectionState([source], [stale]), {
    generatedAt: "2026-08-21T00:00:00.000Z",
    freshnessTtlMs: HOSTED_JOB_FRESHNESS_TTL_MS,
  });

  assert.equal(projection.jobs.length, 0);
  assert.equal(projection.metadata.hostedProjection.freshnessPolicy.maximumAgeDays, 14);
});

test("multi-source jobs fall back to fresh support and drop stale support edges", () => {
  const staleSource = approvedSource("stale-cursor", {
    provider: "ByteDance",
    collection: {
      lastSuccessfulCheckAt: "2026-08-21T00:00:00.000Z",
      missingAdvanceSuppressed: true,
      resume: { schemaVersion: "huangque.collection-resume.v1", generation: 2, nextOffset: 2_000 },
    },
  });
  const freshSource = approvedSource("fresh-secondary");
  const shared = observedJob(staleSource.id, "shared-job", "2026-07-01T00:00:00.000Z");
  shared.sourceIds = [staleSource.id, freshSource.id];
  shared.sourceObservations[freshSource.id] = {
    consecutiveMissing: 0,
    lastObservedAt: "2026-08-20T00:00:00.000Z",
    observedStatus: "confirmed_active",
    activeScore: 98,
    projection: {
      externalId: shared.externalId,
      company: shared.company,
      title: shared.title,
      location: shared.location,
      status: "confirmed_active",
      activeScore: 98,
      sourceUrl: "https://fresh-secondary.example.com/jobs/shared-job",
      applyUrl: "https://fresh-secondary.example.com/jobs/shared-job",
    },
  };
  const state = projectionState([staleSource, freshSource], [shared]);
  state.edges = [
    { id: "edge-stale", from: staleSource.id, to: "job:shared-job", type: "lists_job", evidence: { kind: "test" } },
    { id: "edge-fresh", from: freshSource.id, to: "job:shared-job", type: "lists_job", evidence: { kind: "test" } },
  ];
  const projection = buildHostedProjection(state, { generatedAt: "2026-08-21T00:00:00.000Z" });

  assert.equal(projection.jobs[0].sourceId, freshSource.id);
  assert.deepEqual(projection.jobs[0].sourceIds, [freshSource.id]);
  assert.deepEqual(projection.edges.filter((edge) => edge.type === "lists_job").map((edge) => edge.id), ["edge-fresh"]);
});
