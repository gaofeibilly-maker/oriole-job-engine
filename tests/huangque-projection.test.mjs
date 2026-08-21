import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedProjection, HOSTED_PROJECTION_LIMITS } from "../scripts/huangque/lib/hosted-projection.mjs";

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
