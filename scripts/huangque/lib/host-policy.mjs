import { canonicalizeUrl } from "./source-discovery.mjs";

function parsedCandidateJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function registryApprovalIdentity(source) {
  const candidate = parsedCandidateJson(source?.candidate) || {};
  return JSON.stringify({
    sourceKey: String(source?.sourceKey || candidate.sourceKey || ""),
    provider: String(candidate.provider || ""),
    tenant: String(candidate.tenant || "").toLowerCase(),
    sourceRootUrl: canonicalizeUrl(candidate.sourceRootUrl) || null,
    publicApiUrl: canonicalizeUrl(candidate.publicApiUrl) || null,
  });
}

export function hostedApprovalIdentity(storedCandidate) {
  const candidate = parsedCandidateJson(storedCandidate?.candidateJson) || {};
  return registryApprovalIdentity({ sourceKey: storedCandidate?.sourceKey, candidate });
}

export function approvalIdentityMatches(source, storedCandidate) {
  return !storedCandidate || registryApprovalIdentity(source) === hostedApprovalIdentity(storedCandidate);
}

export function isApprovedRegistrySource(source) {
  const reviewedAt = parseReviewDate(source?.review?.reviewedAt);
  return Boolean(
    source
    && source.lifecycle === "approved"
    && source.reviewStatus === "approved"
    && source.verificationState === "verified"
    && source.collectionEnabled === true
    && typeof source.approvedAt === "string"
    && source.approvedAt.length > 0
    && source.probe?.verificationState === "verified"
    && Array.isArray(source.probe?.evidence)
    && source.probe.evidence.length > 0
    && source.review?.decision === "approve"
    && typeof source.review?.reviewedBy === "string"
    && source.review.reviewedBy.length > 0
    && typeof source.review?.reason === "string"
    && source.review.reason.length > 0
    && reviewedAt
    && !Number.isNaN(reviewedAt.getTime())
  );
}

function parseReviewDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function conservativeReviewTimestamp(value) {
  const parsed = parseReviewDate(value);
  if (!parsed) return Number.NEGATIVE_INFINITY;
  const hasSubsecondPrecision = typeof value === "string" && /\.\d{1,3}(?:Z|[+-]\d{2}:?\d{2})?$/.test(value);
  return parsed.getTime() + (hasSubsecondPrecision ? 0 : 999);
}

export function compareReviewDecisions(left, right) {
  const timeDifference = conservativeReviewTimestamp(left?.createdAt) - conservativeReviewTimestamp(right?.createdAt);
  if (timeDifference !== 0) return timeDifference;
  const revisionDifference = Number(left?.candidateRevision || 0) - Number(right?.candidateRevision || 0);
  if (revisionDifference !== 0) return revisionDifference;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function registryStateDecision(source) {
  if (source?.lifecycle === "approved" && source?.reviewStatus === "approved" && source?.collectionEnabled === true) return "approve";
  if (source?.lifecycle === "rejected" || source?.reviewStatus === "rejected") return "reject";
  return null;
}

function explicitRegistryReview(source) {
  const decision = source?.review?.decision;
  const reviewedAt = source?.review?.reviewedAt;
  const parsed = parseReviewDate(reviewedAt);
  if (
    !["approve", "reject"].includes(decision)
    || typeof source?.review?.reviewedBy !== "string"
    || !source.review.reviewedBy.trim()
    || typeof source?.review?.reason !== "string"
    || !source.review.reason.trim()
    || !parsed
    || Number.isNaN(parsed.getTime())
  ) return null;
  return { decision, reviewedAt: parsed.toISOString(), timestamp: parsed.getTime() };
}

/**
 * @param {Record<string, any>} source
 * @param {{ decision?: string, createdAt?: string } | null} latestDecision
 * @param {{ lifecycle?: string, reviewStatus?: string, verificationState?: string, updatedAt?: string } | null} hostedCandidate
 */
export function evaluateHumanReviewSync(source, latestDecision = null, hostedCandidate = null) {
  const stateDecision = registryStateDecision(source);
  const incomingReview = explicitRegistryReview(source);
  const latestTimestampValue = conservativeReviewTimestamp(latestDecision?.createdAt);
  const latestTimestamp = latestTimestampValue === Number.NEGATIVE_INFINITY ? null : latestTimestampValue;
  const hostedIsApproved = !hostedCandidate || (
    hostedCandidate.lifecycle === "approved"
    && hostedCandidate.reviewStatus === "approved"
    && hostedCandidate.verificationState === "verified"
  );
  const hostedTimestampValue = conservativeReviewTimestamp(hostedCandidate?.updatedAt);
  const hostedSafetyTimestamp = hostedTimestampValue !== Number.NEGATIVE_INFINITY && !hostedIsApproved ? hostedTimestampValue : null;
  const latestReviewTimestamp = latestTimestamp === null ? Number.NEGATIVE_INFINITY : latestTimestamp;
  const activationBarrier = Math.max(
    latestDecision?.decision === "reject" ? latestReviewTimestamp : Number.NEGATIVE_INFINITY,
    hostedSafetyTimestamp === null ? Number.NEGATIVE_INFINITY : hostedSafetyTimestamp,
  );
  if (stateDecision === "approve") {
    if (activationBarrier === Number.NEGATIVE_INFINITY) {
      return {
        allowed: true,
        shouldRecord: Boolean(incomingReview && incomingReview.decision === "approve" && incomingReview.timestamp > latestReviewTimestamp),
        incomingReview,
        reason: latestDecision?.decision === "approve" ? "matches_hosted_human_decision" : "no_hosted_human_decision",
      };
    }
    const explicitLaterOverride = Boolean(
      incomingReview
      && incomingReview.decision === "approve"
      && incomingReview.timestamp > activationBarrier
    );
    return {
      allowed: explicitLaterOverride,
      shouldRecord: explicitLaterOverride,
      incomingReview,
      reason: explicitLaterOverride ? "later_explicit_human_review" : "hosted_human_tombstone",
    };
  }

  if (latestDecision?.decision !== "approve" || latestTimestamp === null) {
    return {
      allowed: true,
      shouldRecord: Boolean(incomingReview && incomingReview.decision === stateDecision && incomingReview.timestamp > latestReviewTimestamp),
      incomingReview,
      reason: stateDecision === "reject" ? "explicit_reject" : "unapproved_state",
    };
  }

  if (stateDecision === "reject") {
    const laterReject = Boolean(incomingReview?.decision === "reject" && incomingReview.timestamp > latestTimestamp);
    return {
      allowed: laterReject,
      shouldRecord: laterReject,
      incomingReview,
      reason: laterReject ? "later_explicit_reject" : "hosted_approval_newer",
    };
  }

  const probeAt = parseReviewDate(source?.probe?.probedAt || source?.lastProbedAt);
  const unsafeProbe = source?.verificationState !== "verified" || (source?.probe && source.probe.verificationState !== "verified");
  const laterUnsafeProbe = Boolean(unsafeProbe && (!probeAt || probeAt.getTime() > latestTimestamp));
  return {
    allowed: laterUnsafeProbe,
    shouldRecord: false,
    incomingReview,
    reason: laterUnsafeProbe ? "later_probe_safety_downgrade" : "hosted_approval_newer",
  };
}

/**
 * @param {Record<string, any>} source
 * @param {Record<string, any> | null} storedCandidate
 * @param {{ reason?: string, shouldRecord?: boolean }} humanReviewPolicy
 */
export function planRegistryCandidateSync(source, storedCandidate, humanReviewPolicy = {}) {
  if (!storedCandidate) return { action: "write", effectiveRevision: source.revision, revisionConflict: false };
  const incomingApproved = isApprovedRegistrySource(source);
  const sameSafetySnapshot = !incomingApproved
    && storedCandidate.lifecycle === source.lifecycle
    && storedCandidate.reviewStatus === source.reviewStatus
    && storedCandidate.verificationState === source.verificationState
    && storedCandidate.lastProbedAt === source.lastProbedAt
    && storedCandidate.candidateJson === JSON.stringify(source.candidate)
    && humanReviewPolicy.shouldRecord !== true;
  if (sameSafetySnapshot) {
    return { action: "reuse", effectiveRevision: storedCandidate.revision, revisionConflict: storedCandidate.revision > source.revision };
  }
  const laterExplicitOverride = humanReviewPolicy.reason === "later_explicit_human_review";
  if (!incomingApproved || laterExplicitOverride) {
    return {
      action: "write",
      effectiveRevision: Math.max(Number(source.revision) || 1, Number(storedCandidate.revision) + 1),
      revisionConflict: storedCandidate.revision > source.revision,
    };
  }
  if (storedCandidate.revision > source.revision) {
    return { action: "conflict", effectiveRevision: storedCandidate.revision, revisionConflict: true };
  }
  return { action: "write", effectiveRevision: source.revision, revisionConflict: false };
}

export function isDisplayableHostedJob({ candidate, source, job }) {
  const validThrough = job?.validThrough ? new Date(job.validThrough) : null;
  return Boolean(
    candidate?.lifecycle === "approved"
    && candidate?.reviewStatus === "approved"
    && candidate?.verificationState === "verified"
    && source?.collectionEnabled === true
    && !["closed", "quarantined"].includes(job?.status)
    && (!validThrough || Number.isNaN(validThrough.getTime()) || validThrough >= new Date())
  );
}

function activeSupportDetails(job, activeSourceIds, now = new Date()) {
  const active = activeSourceIds instanceof Set ? activeSourceIds : new Set(activeSourceIds || []);
  const candidates = [job?.sourceId, ...(Array.isArray(job?.sourceIds) ? job.sourceIds : [])]
    .filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index)
    .filter((sourceId) => active.has(sourceId));
  const observations = job?.sourceObservations && typeof job.sourceObservations === "object" && !Array.isArray(job.sourceObservations)
    ? job.sourceObservations
    : null;
  const hasObservations = Boolean(observations && Object.keys(observations).length > 0);
  const current = new Date(now);
  return {
    candidates,
    hasObservations,
    details: candidates.map((sourceId) => {
      const observation = observations?.[sourceId];
      if (hasObservations && (!observation || typeof observation !== "object")) {
        return { sourceId, observation: null, missing: 0, closed: true, needsReview: true, expired: false };
      }
      const missing = Math.max(0, Number(observation?.consecutiveMissing || 0));
      const threshold = Math.max(2, Number(observation?.closureThreshold || 2));
      const validityValue = observation?.validThrough ?? observation?.projection?.validThrough ?? null;
      const validThrough = validityValue ? new Date(validityValue) : null;
      const invalidValidity = Boolean(validityValue && (!validThrough || Number.isNaN(validThrough.getTime())));
      const expired = Boolean(validThrough && !Number.isNaN(validThrough.getTime()) && validThrough < current);
      const observedStatus = String(observation?.observedStatus || job?.status || "confirmed_active");
      const healthState = String(observation?.healthState || "healthy");
      const closed = observedStatus === "closed" || missing >= threshold || expired;
      const unavailable = ["source_unreachable", "source_data_conflict"].includes(healthState);
      return {
        sourceId,
        observation: observation || null,
        missing,
        closed,
        unavailable,
        expired,
        needsReview: invalidValidity || observedStatus === "needs_review" || healthState !== "healthy" || missing >= 1,
      };
    }),
  };
}

export function activeHostedJobSourceId(job, activeSourceIds, now = new Date()) {
  const support = activeSupportDetails(job, activeSourceIds, now);
  if (!support.hasObservations) {
    const sourceId = support.candidates[0] || null;
    if (!sourceId) return null;
    const projected = hostedJobForSource(job, sourceId, null);
    const validThrough = projected.validThrough ? new Date(projected.validThrough) : null;
    if (projected.status === "closed" || (validThrough && !Number.isNaN(validThrough.getTime()) && validThrough < new Date(now))) return null;
    return sourceId;
  }
  return support.details.find((item) => !item.closed && !item.unavailable)?.sourceId
    || support.details.find((item) => !item.closed)?.sourceId
    || null;
}

const PROJECTION_TEXT_FIELDS = [
  "externalId", "company", "title", "location", "department", "employmentType", "workplaceType", "salary",
  "locationRaw", "regionProvince", "regionProvinceCode", "regionCity", "regionCityCode", "regionLabel", "locationBasis",
  "publishedAt", "validThrough", "description", "freshness", "freshnessState", "parser", "contentHash", "urlIdentity",
];
const PROJECTION_NUMBER_FIELDS = ["activeScore", "authenticityScore", "channelScore"];

function safeProjection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const output = {};
  for (const key of PROJECTION_TEXT_FIELDS) {
    if (typeof raw[key] === "string" || raw[key] === null) output[key] = raw[key];
  }
  for (const key of PROJECTION_NUMBER_FIELDS) {
    if (Number.isFinite(raw[key])) output[key] = Number(raw[key]);
  }
  if (Array.isArray(raw.workLocations || raw.regions)) {
    output.workLocations = (raw.workLocations || raw.regions).slice(0, 32).flatMap((region) => {
      if (!region || typeof region !== "object" || Array.isArray(region)) return [];
      return [{
        countryCode: region.countryCode === "CN" ? "CN" : null,
        provinceCode: typeof region.provinceCode === "string" ? region.provinceCode : null,
        provinceName: typeof region.provinceName === "string" ? region.provinceName : null,
        cityCode: typeof region.cityCode === "string" ? region.cityCode : null,
        cityName: typeof region.cityName === "string" ? region.cityName : null,
        label: typeof region.label === "string" ? region.label : null,
        remote: Boolean(region.remote),
        confidence: Number.isFinite(region.confidence) ? Number(region.confidence) : 0,
        basis: typeof region.basis === "string" ? region.basis : null,
      }];
    });
    output.regions = output.workLocations;
  }
  return output;
}

/**
 * @param {Record<string, any>} job
 * @param {string} sourceId
 * @param {string | null} fallbackSourceUrl
 */
export function hostedJobForSource(job, sourceId, fallbackSourceUrl = null) {
  const rawProjection = job?.sourceObservations?.[sourceId]?.projection;
  const projection = safeProjection(rawProjection);
  const projectionSourceUrl = canonicalizeUrl(rawProjection?.sourceUrl);
  const projectionApplyUrl = canonicalizeUrl(rawProjection?.applyUrl);
  const safeFallback = canonicalizeUrl(fallbackSourceUrl);
  const topSourceUrl = canonicalizeUrl(job?.sourceUrl);
  const topApplyUrl = canonicalizeUrl(job?.applyUrl);
  const sourceUrl = projectionSourceUrl || safeFallback || topSourceUrl || "";
  const applyUrl = projectionApplyUrl || projectionSourceUrl || safeFallback || topApplyUrl || topSourceUrl || "";
  return {
    ...job,
    ...projection,
    sourceId,
    sourceUrl,
    applyUrl,
  };
}

/**
 * Resolve the current per-job support set, project the first still-valid source,
 * and recompute aggregate status without trusting nested snapshot fields.
 * @param {Record<string, any>} job
 * @param {Set<string> | string[]} activeSourceIds
 * @param {Map<string, string> | Record<string, string> | null} sourceRoots
 * @param {Date | string | number} now
 * @returns {{ sourceId: string | null, eligibleSourceId: string | null, job: Record<string, any> }}
 */
export function resolveHostedJob(job, activeSourceIds, sourceRoots = null, now = new Date()) {
  const support = activeSupportDetails(job, activeSourceIds, now);
  if (!support.candidates.length) {
    return { sourceId: null, eligibleSourceId: null, job: { ...job, status: "quarantined", activeScore: 0 } };
  }
  const eligible = support.details.filter((item) => !item.closed);
  const reachable = eligible.filter((item) => !item.unavailable);
  const selectedSourceId = reachable[0]?.sourceId || eligible[0]?.sourceId || support.details[0]?.sourceId || support.candidates[0];
  const sourceRoot = sourceRoots instanceof Map ? sourceRoots.get(selectedSourceId) : sourceRoots?.[selectedSourceId];
  const projected = hostedJobForSource(job, selectedSourceId, sourceRoot || null);
  let status;
  if (!support.hasObservations) {
    const validThrough = projected.validThrough ? new Date(projected.validThrough) : null;
    const expired = Boolean(validThrough && !Number.isNaN(validThrough.getTime()) && validThrough < new Date(now));
    status = expired ? "closed" : String(projected.status || "needs_review");
  } else if (!eligible.length) {
    status = "closed";
  } else if (
    support.details.some((item) => item.closed)
    || eligible.some((item) => item.needsReview)
  ) {
    status = "needs_review";
  } else {
    status = "confirmed_active";
  }
  const aggregateActiveScore = eligible.length
    ? Math.max(...eligible.map((item) => Number(item.observation?.activeScore ?? item.observation?.projection?.activeScore ?? 0)))
    : 0;
  const conflict = support.hasObservations && eligible.length > 0 && support.details.some((item) => item.closed);
  const resolved = {
    ...projected,
    sourceId: selectedSourceId,
    sourceIds: support.candidates,
    status,
    activeScore: status === "closed" ? 0 : Math.max(Number(projected.activeScore || 0), aggregateActiveScore),
    consecutiveMissing: eligible.length ? Math.min(...eligible.map((item) => item.missing)) : Math.min(...support.details.map((item) => item.missing)),
    validThrough: conflict ? null : projected.validThrough ?? null,
    freshness: conflict ? "部分来源已失效，已切换到仍有效来源" : projected.freshness,
    freshnessState: conflict ? "source_support_conflict" : projected.freshnessState,
  };
  if (!resolved.sourceUrl || !resolved.applyUrl) {
    resolved.status = "quarantined";
    resolved.activeScore = 0;
  }
  return {
    sourceId: resolved.status === "quarantined" ? null : selectedSourceId,
    eligibleSourceId: eligible[0]?.sourceId || null,
    job: resolved,
  };
}

export function hostedJobColumns(job, updatedAt = new Date().toISOString()) {
  return {
    externalId: job.externalId ? String(job.externalId) : null,
    company: String(job.company || "发布单位待核验"),
    title: String(job.title || "未命名岗位"),
    location: String(job.location || "地点未提供"),
    department: String(job.department || "未分类"),
    employmentType: String(job.employmentType || "未说明"),
    salary: String(job.salary || "薪资未公开"),
    sourceUrl: String(job.sourceUrl || ""),
    applyUrl: String(job.applyUrl || job.sourceUrl || ""),
    publishedAt: job.publishedAt ? String(job.publishedAt) : null,
    validThrough: job.validThrough ? String(job.validThrough) : null,
    lastObservedAt: String(job.lastObservedAt || job.observedAt || updatedAt),
    status: String(job.status || "needs_review"),
    activeScore: Number(job.activeScore || 0),
    authenticityScore: Number(job.authenticityScore || 0),
    channelScore: Number(job.channelScore || 0),
    contentHash: String(job.contentHash || job.id),
    version: Number(job.version || 1),
    consecutiveMissing: Number(job.consecutiveMissing || 0),
    dataJson: JSON.stringify(job),
    updatedAt,
  };
}
