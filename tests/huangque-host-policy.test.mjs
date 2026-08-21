import assert from "node:assert/strict";
import test from "node:test";
import { activeHostedJobSourceId, compareReviewDecisions, evaluateHumanReviewSync, hostedJobColumns, hostedJobForSource, isApprovedRegistrySource, isDisplayableHostedJob, planRegistryCandidateSync, resolveHostedJob } from "../scripts/huangque/lib/host-policy.mjs";
import { canonicalizeUrl } from "../scripts/huangque/lib/source-discovery.mjs";

function approvedSource(overrides = {}) {
  return {
    lifecycle: "approved",
    reviewStatus: "approved",
    verificationState: "verified",
    collectionEnabled: true,
    approvedAt: "2026-08-20T00:00:00.000Z",
    probe: { verificationState: "verified", evidence: [{ kind: "http_observation" }] },
    review: { decision: "approve", reviewedBy: "owner", reason: "公开接口和岗位样本已核验", reviewedAt: "2026-08-20T00:00:00.000Z" },
    ...overrides,
  };
}

test("host sync activates only a source with verified probe and explicit approval evidence", () => {
  assert.equal(isApprovedRegistrySource(approvedSource()), true);
  assert.equal(isApprovedRegistrySource(approvedSource({ lifecycle: "rejected" })), false);
  assert.equal(isApprovedRegistrySource(approvedSource({ probe: null })), false);
  assert.equal(isApprovedRegistrySource(approvedSource({ probe: { verificationState: "verified", evidence: [] } })), false);
  assert.equal(isApprovedRegistrySource(approvedSource({ review: { decision: "approve", reviewedBy: "", reason: "x" } })), false);
});

test("hosted human review is a tombstone until a later explicit opposite review", () => {
  const rejectedAtHost = { decision: "reject", createdAt: "2026-08-20T01:00:00.000Z" };
  const staleApproved = approvedSource({
    review: { decision: "approve", reviewedBy: "owner", reason: "旧批准", reviewedAt: "2026-08-20T00:00:00.000Z" },
  });
  assert.deepEqual(evaluateHumanReviewSync(staleApproved, rejectedAtHost), {
    allowed: false,
    shouldRecord: false,
    incomingReview: { decision: "approve", reviewedAt: "2026-08-20T00:00:00.000Z", timestamp: Date.parse("2026-08-20T00:00:00.000Z") },
    reason: "hosted_human_tombstone",
  });
  const laterApproved = approvedSource({
    review: { decision: "approve", reviewedBy: "owner", reason: "重新核验并批准", reviewedAt: "2026-08-20T02:00:00.000Z" },
  });
  const override = evaluateHumanReviewSync(laterApproved, rejectedAtHost);
  assert.equal(override.allowed, true);
  assert.equal(override.shouldRecord, true);
  assert.equal(override.reason, "later_explicit_human_review");
  const matchingRejected = { lifecycle: "rejected", reviewStatus: "rejected", collectionEnabled: false, review: { decision: "reject", reviewedBy: "owner", reason: "已拒绝", reviewedAt: "2026-08-20T01:00:00.000Z" } };
  assert.equal(evaluateHumanReviewSync(matchingRejected, rejectedAtHost).allowed, true);
  assert.equal(evaluateHumanReviewSync({ lifecycle: "candidate", reviewStatus: "unreviewed", collectionEnabled: false }, rejectedAtHost).allowed, true);
  const legacySecondPrecisionReject = { decision: "reject", createdAt: "2026-08-20 01:00:00" };
  const sameSecondStaleApproval = approvedSource({
    review: { decision: "approve", reviewedBy: "owner", reason: "同秒旧批准", reviewedAt: "2026-08-20T01:00:00.900Z" },
  });
  assert.equal(evaluateHumanReviewSync(sameSecondStaleApproval, legacySecondPrecisionReject).allowed, false);
});

test("mixed legacy and ISO review timestamps are ordered by time rather than text", () => {
  const legacyLate = { id: "legacy", candidateRevision: 8, createdAt: "2026-08-20 23:00:00" };
  const isoEarly = { id: "iso", candidateRevision: 9, createdAt: "2026-08-20T01:00:00.500Z" };
  assert.ok(compareReviewDecisions(legacyLate, isoEarly) > 0);
  assert.ok(compareReviewDecisions(isoEarly, legacyLate) < 0);
});

test("a hosted approval never keeps an automatically failed probe active", () => {
  const hostedApproval = { decision: "approve", createdAt: "2026-08-20T01:00:00.000Z" };
  const hostedCandidate = { lifecycle: "approved", reviewStatus: "approved", verificationState: "verified", updatedAt: "2026-08-20T01:00:00.000Z" };
  const failedProbe = {
    lifecycle: "probed",
    reviewStatus: "blocked",
    verificationState: "access_restricted",
    collectionEnabled: false,
    review: { decision: "approve", reviewedBy: "owner", reason: "旧批准", reviewedAt: "2026-08-20T00:00:00.000Z" },
  };
  const downgrade = evaluateHumanReviewSync(failedProbe, hostedApproval, hostedCandidate);
  assert.equal(downgrade.allowed, true);
  assert.equal(downgrade.reason, "later_probe_safety_downgrade");
  const hostedBlocked = { lifecycle: "probed", reviewStatus: "blocked", verificationState: "access_restricted", updatedAt: "2026-08-20T02:00:00.000Z" };
  const staleApproval = approvedSource({ review: { decision: "approve", reviewedBy: "owner", reason: "旧批准", reviewedAt: "2026-08-20T01:30:00.000Z" } });
  assert.equal(evaluateHumanReviewSync(staleApproval, hostedApproval, hostedBlocked).allowed, false);
  const recoveredApproval = approvedSource({ review: { decision: "approve", reviewedBy: "owner", reason: "重新探测并批准", reviewedAt: "2026-08-20T03:00:00.000Z" } });
  assert.equal(evaluateHumanReviewSync(recoveredApproval, hostedApproval, hostedBlocked).allowed, true);
});

test("a D1 human approval survives a stale portable pending or reject snapshot", () => {
  const hostedApproval = { decision: "approve", createdAt: "2026-08-20T02:00:00.000Z" };
  const hostedCandidate = { lifecycle: "approved", reviewStatus: "approved", verificationState: "verified", updatedAt: "2026-08-20T02:00:00.000Z" };
  const portablePending = {
    lifecycle: "probed",
    reviewStatus: "pending",
    verificationState: "verified",
    collectionEnabled: false,
    lastProbedAt: "2026-08-20T01:00:00.000Z",
    probe: { verificationState: "verified", probedAt: "2026-08-20T01:00:00.000Z" },
    review: null,
  };
  const pendingPolicy = evaluateHumanReviewSync(portablePending, hostedApproval, hostedCandidate);
  assert.equal(pendingPolicy.allowed, false);
  assert.equal(pendingPolicy.reason, "hosted_approval_newer");
  const staleReject = {
    ...portablePending,
    lifecycle: "rejected",
    reviewStatus: "rejected",
    review: { decision: "reject", reviewedBy: "owner", reason: "旧拒绝", reviewedAt: "2026-08-20T01:30:00.000Z" },
  };
  assert.equal(evaluateHumanReviewSync(staleReject, hostedApproval, hostedCandidate).allowed, false);
  const laterReject = {
    ...staleReject,
    review: { ...staleReject.review, reviewedAt: "2026-08-20T03:00:00.000Z" },
  };
  const rejectPolicy = evaluateHumanReviewSync(laterReject, hostedApproval, hostedCandidate);
  assert.equal(rejectPolicy.allowed, true);
  assert.equal(rejectPolicy.shouldRecord, true);
  assert.equal(rejectPolicy.reason, "later_explicit_reject");
});

test("safety downgrade is idempotent and a later explicit approval can cross a hosted revision gap", () => {
  const candidate = { sourceRootUrl: "https://jobs.example.com" };
  const failed = { revision: 6, lifecycle: "probed", reviewStatus: "blocked", verificationState: "access_restricted", collectionEnabled: false, lastProbedAt: "2026-08-20T02:00:00.000Z", candidate };
  const hostedApproved = { revision: 10, lifecycle: "approved", reviewStatus: "approved", verificationState: "verified", lastProbedAt: "2026-08-20T01:00:00.000Z", candidateJson: JSON.stringify(candidate) };
  const firstDowngrade = planRegistryCandidateSync(failed, hostedApproved, { reason: "safety_downgrade", shouldRecord: false });
  assert.deepEqual(firstDowngrade, { action: "write", effectiveRevision: 11, revisionConflict: true });
  const hostedBlocked = { ...hostedApproved, revision: 11, lifecycle: "probed", reviewStatus: "blocked", verificationState: "access_restricted", lastProbedAt: failed.lastProbedAt };
  assert.deepEqual(planRegistryCandidateSync(failed, hostedBlocked, { reason: "safety_downgrade", shouldRecord: false }), { action: "reuse", effectiveRevision: 11, revisionConflict: true });
  const recovered = approvedSource({ revision: 8, candidate, lastProbedAt: "2026-08-20T03:00:00.000Z", review: { decision: "approve", reviewedBy: "owner", reason: "重新批准", reviewedAt: "2026-08-20T03:00:00.000Z" } });
  assert.deepEqual(planRegistryCandidateSync(recovered, hostedBlocked, { reason: "later_explicit_human_review", shouldRecord: true }), { action: "write", effectiveRevision: 12, revisionConflict: true });
  assert.equal(planRegistryCandidateSync(recovered, hostedBlocked, { reason: "hosted_human_tombstone", shouldRecord: false }).action, "conflict");
});

test("host read policy hides disabled, rejected, closed and quarantined jobs", () => {
  const candidate = { lifecycle: "approved", reviewStatus: "approved", verificationState: "verified" };
  const source = { collectionEnabled: true };
  assert.equal(isDisplayableHostedJob({ candidate, source, job: { status: "confirmed_active" } }), true);
  assert.equal(isDisplayableHostedJob({ candidate: { ...candidate, lifecycle: "rejected" }, source, job: { status: "confirmed_active" } }), false);
  assert.equal(isDisplayableHostedJob({ candidate, source: { collectionEnabled: false }, job: { status: "confirmed_active" } }), false);
  assert.equal(isDisplayableHostedJob({ candidate, source, job: { status: "closed" } }), false);
  assert.equal(isDisplayableHostedJob({ candidate, source, job: { status: "quarantined" } }), false);
  assert.equal(isDisplayableHostedJob({ candidate, source, job: { status: "confirmed_active", validThrough: "2000-01-01T00:00:00.000Z" } }), false);
});

test("hosted links share the portable URL safety boundary", () => {
  assert.ok(canonicalizeUrl("https://jobs.example.com/beijing"));
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
  assert.equal(canonicalizeUrl("https://user:secret@jobs.example.com/"), null);
  assert.equal(canonicalizeUrl("http://127.0.0.1/jobs"), null);
});

test("host sync column projection updates every field used by the jobs API", () => {
  const first = hostedJobColumns({ id: "job", company: "甲", title: "工程师", location: "北京", department: "研发", employmentType: "全职", salary: "8000", sourceUrl: "https://jobs.example.com/1", applyUrl: "https://jobs.example.com/1/apply", validThrough: "2026-08-30T00:00:00.000Z", activeScore: 80, authenticityScore: 90, channelScore: 70, contentHash: "one" }, "2026-08-20T00:00:00.000Z");
  const next = hostedJobColumns({ id: "job", company: "乙", title: "高级工程师", location: "北京·海淀", department: "平台", employmentType: "合同", salary: "12000", sourceUrl: "https://jobs.example.com/2", applyUrl: "https://jobs.example.com/2/apply", validThrough: "2026-09-30T00:00:00.000Z", activeScore: 88, authenticityScore: 99, channelScore: 95, contentHash: "two", version: 2 }, "2026-08-21T00:00:00.000Z");
  for (const key of ["company", "title", "location", "department", "employmentType", "salary", "sourceUrl", "applyUrl", "validThrough", "activeScore", "authenticityScore", "channelScore", "contentHash", "version"]) {
    assert.notEqual(first[key], next[key], key);
  }
});

test("host sync reassigns a merged job to another active supporting source", () => {
  const job = { sourceId: "source-a", sourceIds: ["source-a", "source-b"], sourceUrl: "https://a.example/jobs/1", applyUrl: "https://apply.example/1", sourceObservations: { "source-b": { projection: { sourceUrl: "https://b.example/jobs/1", title: "B 标题" } } } };
  assert.equal(activeHostedJobSourceId(job, new Set(["source-b"])), "source-b");
  assert.equal(activeHostedJobSourceId(job, new Set()), null);
  const projected = hostedJobForSource(job, "source-b", "https://b.example/jobs");
  assert.equal(projected.sourceId, "source-b");
  assert.equal(projected.sourceUrl, "https://b.example/jobs/1");
  assert.equal(projected.title, "B 标题");
});

test("host selection skips a per-job missing or naturally expired primary support", () => {
  const roots = new Map([["primary", "https://primary.example/jobs"], ["secondary", "https://secondary.example/jobs"]]);
  const base = {
    sourceId: "primary",
    sourceIds: ["primary", "secondary"],
    sourceUrl: "https://primary.example/jobs/shared",
    applyUrl: "https://apply.example/shared",
    status: "confirmed_active",
    sourceObservations: {
      primary: { consecutiveMissing: 2, closureThreshold: 2, observedStatus: "confirmed_active", projection: { title: "主来源旧标题", sourceUrl: "https://primary.example/jobs/shared", applyUrl: "https://primary.example/jobs/shared" } },
      secondary: { consecutiveMissing: 0, observedStatus: "confirmed_active", activeScore: 98, projection: { title: "次来源有效标题", sourceUrl: "https://secondary.example/jobs/shared", applyUrl: "https://secondary.example/jobs/shared", activeScore: 98 } },
    },
  };
  const active = new Set(["primary", "secondary"]);
  assert.equal(activeHostedJobSourceId(base, active, "2026-08-22T00:00:00.000Z"), "secondary");
  let resolved = resolveHostedJob(base, active, roots, "2026-08-22T00:00:00.000Z");
  assert.equal(resolved.sourceId, "secondary");
  assert.equal(resolved.job.title, "次来源有效标题");
  assert.equal(resolved.job.sourceUrl, "https://secondary.example/jobs/shared");
  assert.equal(resolved.job.status, "needs_review");
  const afterPrimaryRevoked = resolveHostedJob(base, new Set(["secondary"]), roots, "2026-08-22T00:00:00.000Z");
  assert.equal(afterPrimaryRevoked.sourceId, "secondary");
  assert.equal(afterPrimaryRevoked.job.status, "confirmed_active");
  const naturallyExpired = structuredClone(base);
  naturallyExpired.sourceObservations.primary.consecutiveMissing = 0;
  naturallyExpired.sourceObservations.primary.projection.validThrough = "2026-08-21T23:59:59.999Z";
  resolved = resolveHostedJob(naturallyExpired, active, roots, "2026-08-22T00:00:00.000Z");
  assert.equal(resolved.sourceId, "secondary");
  assert.equal(resolved.job.status, "needs_review");
  assert.equal(resolved.job.validThrough, null);
  naturallyExpired.sourceObservations.secondary.observedStatus = "closed";
  resolved = resolveHostedJob(naturallyExpired, active, roots, "2026-08-22T00:00:00.000Z");
  assert.equal(resolved.job.status, "closed");
  assert.equal(resolved.job.activeScore, 0);
});

test("nested source projections are allowlisted and unsafe URLs fail closed to the source root", () => {
  const job = {
    sourceId: "safe",
    sourceIds: ["safe"],
    status: "confirmed_active",
    sourceUrl: "https://safe.example/jobs/1",
    applyUrl: "https://safe.example/jobs/1",
    evidence: [{ kind: "trusted" }],
    sourceObservations: {
      safe: {
        observedStatus: "confirmed_active",
        projection: {
          title: "安全标题",
          sourceUrl: "http://169.254.169.254/latest/meta-data",
          applyUrl: "javascript:alert(1)",
          status: "confirmed_active",
          sourceIds: ["attacker"],
          evidence: [{ kind: "forged" }],
          version: 999,
        },
      },
    },
  };
  const projected = hostedJobForSource(job, "safe", "https://safe.example/jobs");
  assert.equal(projected.sourceUrl, "https://safe.example/jobs");
  assert.equal(projected.applyUrl, "https://safe.example/jobs");
  assert.deepEqual(projected.sourceIds, ["safe"]);
  assert.deepEqual(projected.evidence, [{ kind: "trusted" }]);
  assert.notEqual(projected.version, 999);
});
