import { resolveHostedJob } from "./host-policy.mjs";
import { HOSTED_D1_ROW_MAX_BYTES, hostedD1RowBytes } from "./host-row-safety.mjs";

export const HOSTED_PROJECTION_LIMITS = Object.freeze({
  sources: 60,
  edges: 200,
  runs: 30,
  jobs: 300,
  bytes: 7_500_000,
  d1RowBytes: HOSTED_D1_ROW_MAX_BYTES,
});

export const HOSTED_JOB_FRESHNESS_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const HOSTED_FRESHNESS_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SOURCE_CHECK_COMMIT_CORRELATION_MS = 15 * 60 * 1_000;
const PER_JOB_FRESHNESS_PROVIDERS = new Set(["bytedance", "feishurecruitment"]);

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedProvider(source) {
  return String(source?.candidate?.provider || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function requiresPerJobFreshness(source) {
  const collection = source?.collection;
  const strategies = `${source?.candidate?.collectionStrategy || ""} ${source?.probe?.strategy || ""}`;
  return PER_JOB_FRESHNESS_PROVIDERS.has(normalizedProvider(source))
    || collection?.resume?.schemaVersion === "huangque.collection-resume.v1"
    || /(?:cursor|offset|pag(?:e|ed|ination))/i.test(strategies);
}

function isRecent(value, now, ttlMs) {
  const observedAt = timestamp(value);
  if (!observedAt || !now) return false;
  const age = now - observedAt;
  return age >= -HOSTED_FRESHNESS_CLOCK_SKEW_MS && age <= ttlMs;
}

function correlatedTimestamp(checkValue, committedValue) {
  const checkAt = timestamp(checkValue);
  const committedAt = timestamp(committedValue);
  if (!checkAt || !committedAt) return null;
  return Math.abs(checkAt - committedAt) <= SOURCE_CHECK_COMMIT_CORRELATION_MS
    ? checkValue
    : committedValue;
}

function sourceWideFreshnessEvidence(source) {
  if (requiresPerJobFreshness(source)) return null;
  const collection = source?.collection || {};
  const successfulCheckAt = collection.lastSuccessfulCheckAt;
  if (!successfulCheckAt) return null;
  const committed304 = Number(collection.httpValidator?.status) === 304 && collection.lastNotModifiedAt;
  if (committed304) {
    const observedAt = correlatedTimestamp(successfulCheckAt, collection.lastNotModifiedAt);
    return observedAt ? { basis: "source_http_304", observedAt } : null;
  }
  const authoritativeFull = collection.missingAdvanceSuppressed === false && collection.lastCollectedAt;
  if (authoritativeFull) {
    const observedAt = correlatedTimestamp(successfulCheckAt, collection.lastCollectedAt);
    return observedAt ? { basis: "source_authoritative_full_collection", observedAt } : null;
  }
  return null;
}

function supportFreshnessEvidence(source, job, now, ttlMs) {
  const observation = job?.sourceObservations?.[source.id];
  if (observation && isRecent(observation.lastObservedAt, now, ttlMs)) {
    return { basis: "job_source_observation", observedAt: observation.lastObservedAt };
  }
  const sourceWide = sourceWideFreshnessEvidence(source);
  if (sourceWide && isRecent(sourceWide.observedAt, now, ttlMs)) return sourceWide;
  return null;
}

function sourcePriority(source) {
  const approved = source.lifecycle === "approved" && source.reviewStatus === "approved" && source.collectionEnabled === true;
  const reviewable = source.verificationState === "verified" && source.reviewStatus === "pending";
  return [approved ? 0 : reviewable ? 1 : source.lifecycle === "rejected" ? 3 : 2, -timestamp(source.approvedAt || source.lastProbedAt || source.lastDiscoveredAt), String(source.id)];
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    if (typeof left[index] === "number" && typeof right[index] === "number") return left[index] - right[index];
    return String(left[index]).localeCompare(String(right[index]));
  }
  return 0;
}

function compactTree(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, 4_096);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[projection depth limit]";
  if (Array.isArray(value)) return value.slice(-32).map((item) => compactTree(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, compactTree(item, depth + 1)]));
}

function compactSource(source) {
  return {
    id: source.id,
    revision: source.revision,
    sourceKey: source.sourceKey,
    name: String(source.name || "").slice(0, 500),
    lifecycle: source.lifecycle,
    reviewStatus: source.reviewStatus,
    verificationState: source.verificationState,
    collectionEnabled: Boolean(source.collectionEnabled),
    discoveredAt: source.discoveredAt,
    lastDiscoveredAt: source.lastDiscoveredAt,
    lastProbedAt: source.lastProbedAt,
    approvedAt: source.approvedAt,
    rejectedAt: source.rejectedAt,
    candidate: compactTree(source.candidate || {}),
    probe: compactTree(source.probe),
    review: compactTree(source.review),
    collection: compactTree(source.collection),
    runIds: Array.isArray(source.runIds) ? source.runIds.slice(0, 20) : [],
  };
}

function compactEvidence(evidence, selectedSourceIds) {
  const allowed = (Array.isArray(evidence) ? evidence : [])
    .filter((item) => !item?.sourceId || selectedSourceIds.has(item.sourceId));
  const criticalKinds = new Set(["collection_artifact", "source_support_revoked", "source_projection_fallback"]);
  const critical = allowed.filter((item) => criticalKinds.has(item?.kind)).slice(-4).map((item) => compactTree(item));
  const recent = allowed.slice(-8).map((item) => compactTree(item));
  return [...new Map([...critical, ...recent].map((item) => [JSON.stringify(item), item])).values()].slice(-12);
}

function compactJob(job, selectedSourceIds) {
  const sourceIds = [...new Set([job.sourceId, ...(job.sourceIds || [])])].filter((sourceId) => selectedSourceIds.has(sourceId));
  const observations = job.sourceObservations && typeof job.sourceObservations === "object" && !Array.isArray(job.sourceObservations)
    ? Object.fromEntries(Object.entries(job.sourceObservations).filter(([sourceId]) => selectedSourceIds.has(sourceId)))
    : {};
  return {
    ...compactTree(job),
    sourceId: sourceIds.includes(job.sourceId) ? job.sourceId : sourceIds[0],
    sourceIds,
    sourceObservations: compactTree(observations),
    description: String(job.description || "").slice(0, 1_200),
    evidence: compactEvidence(job.evidence, selectedSourceIds),
  };
}

function fitsD1Row(value, limits) {
  return hostedD1RowBytes(value) <= (limits.d1RowBytes || HOSTED_PROJECTION_LIMITS.d1RowBytes);
}

function jobPriority(job) {
  const state = job.status === "confirmed_active" ? 0 : job.status === "needs_review" ? 1 : 2;
  return [state, -Number(job.activeScore || 0), -Number(job.authenticityScore || 0), -timestamp(job.lastObservedAt || job.observedAt || job.updatedAt), String(job.id)];
}

export function buildHostedProjection(state, {
  limits = HOSTED_PROJECTION_LIMITS,
  generatedAt = new Date().toISOString(),
  freshnessTtlMs = HOSTED_JOB_FRESHNESS_TTL_MS,
} = {}) {
  if (!state || state.schemaVersion !== "huangque.registry.v1") throw new TypeError("huangque.registry.v1 snapshot required");
  const projectionTime = timestamp(generatedAt);
  if (!projectionTime) throw new TypeError("generatedAt must be a valid projection timestamp");
  if (!Number.isFinite(freshnessTtlMs) || freshnessTtlMs <= 0) throw new TypeError("freshnessTtlMs must be a positive number");
  const sortedSources = [...(state.sources || [])].sort((left, right) => compareTuple(sourcePriority(left), sourcePriority(right)));
  const selectedSourcePairs = sortedSources
    .map((source) => ({ source, compact: compactSource(source) }))
    .filter(({ compact }) => fitsD1Row(compact, limits))
    .slice(0, limits.sources);
  const selectedSources = selectedSourcePairs.map(({ source }) => source);
  const sources = selectedSourcePairs.map(({ compact }) => compact);
  const selectedSourceIds = new Set(sources.map((source) => source.id));
  const activeSourceIds = new Set(selectedSources
    .filter((source) => source.lifecycle === "approved" && source.reviewStatus === "approved" && source.verificationState === "verified" && source.collectionEnabled === true)
    .map((source) => source.id));
  const sourcesById = new Map(selectedSources.map((source) => [source.id, source]));
  const sourceRoots = new Map(selectedSources.map((source) => [source.id, source.candidate?.sourceRootUrl]).filter(([, root]) => root));
  const freshnessStats = { eligibleActiveJobs: 0, freshJobs: 0, excludedWithoutFreshSupport: 0 };
  const freshJobSourceIds = new Map();
  const projectedJobs = (state.jobs || []).flatMap((job) => {
    if (job?.status !== "confirmed_active") return [];
    freshnessStats.eligibleActiveJobs += 1;
    const supportIds = [...new Set([job?.sourceId, ...(Array.isArray(job?.sourceIds) ? job.sourceIds : [])])]
      .filter((sourceId) => activeSourceIds.has(sourceId));
    const evidenceBySource = new Map(supportIds.flatMap((sourceId) => {
      const source = sourcesById.get(sourceId);
      const evidence = source ? supportFreshnessEvidence(source, job, projectionTime, freshnessTtlMs) : null;
      return evidence ? [[sourceId, evidence]] : [];
    }));
    if (evidenceBySource.size === 0) {
      freshnessStats.excludedWithoutFreshSupport += 1;
      return [];
    }
    const resolved = resolveHostedJob(job, new Set(evidenceBySource.keys()), sourceRoots, generatedAt);
    if (!resolved.sourceId || resolved.job.status !== "confirmed_active") return [];
    const freshness = evidenceBySource.get(resolved.sourceId);
    const freshSourceIds = new Set(evidenceBySource.keys());
    const compact = compactJob({
      ...resolved.job,
      hostedFreshness: {
        schemaVersion: "huangque.hosted-job-freshness.v1",
        basis: freshness.basis,
        observedAt: freshness.observedAt,
        maximumAgeDays: freshnessTtlMs / (24 * 60 * 60 * 1_000),
      },
    }, freshSourceIds);
    freshJobSourceIds.set(String(compact.id), freshSourceIds);
    freshnessStats.freshJobs += 1;
    return fitsD1Row(compact, limits) ? [compact] : [];
  }).sort((left, right) => compareTuple(jobPriority(left), jobPriority(right)));
  let jobs = projectedJobs.slice(0, limits.jobs);
  const projectedEdges = (state.edges || [])
    .filter((edge) => selectedSourceIds.has(edge.from) && (!String(edge.to || "").startsWith("huangque-") || selectedSourceIds.has(edge.to)))
    .map((edge) => compactTree({ ...edge, evidence: edge.evidence && typeof edge.evidence === "object" ? edge.evidence : {} }))
    .filter((edge) => fitsD1Row(edge, limits));
  const edgesForJobs = (selectedJobs) => {
    const selectedJobIds = new Set(selectedJobs.map((job) => String(job.id)));
    return projectedEdges
      .filter((edge) => {
        if (edge.type !== "lists_job") return true;
        const jobId = String(edge.to || "").replace(/^job:/, "");
        return selectedJobIds.has(jobId) && freshJobSourceIds.get(jobId)?.has(edge.from);
      })
      .slice(0, limits.edges);
  };
  let edges = edgesForJobs(jobs);
  const runs = (state.runs || []).map((run) => compactTree({
      id: run.id,
      kind: run.kind,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      input: run.input || {},
      stats: run.stats || {},
      providerRuns: run.providerRuns || [],
      errors: run.errors || [],
      output: run.output || {},
    }))
    .filter((run) => fitsD1Row(run, limits))
    .slice(0, limits.runs);
  const base = {
    schemaVersion: "huangque.registry.v1",
    revision: Number(state.revision || 0),
    metadata: {
      ...compactTree(state.metadata || {}),
      hostedProjection: {
        schemaVersion: "huangque.hosted-projection.v1",
        generatedAt,
        policy: "approved/reviewable sources first; confirmed_active jobs require fresh source-scoped evidence",
        freshnessPolicy: {
          schemaVersion: "huangque.hosted-freshness-policy.v1",
          maximumAgeDays: freshnessTtlMs / (24 * 60 * 60 * 1_000),
          cursorSources: "fresh per-job sourceObservations only; a partial source success never renews unseen jobs",
          sourceWideChecks: "non-cursor sources only; requires committed authoritative full collection or HTTP 304 evidence correlated with lastSuccessfulCheckAt",
          stats: freshnessStats,
        },
        limits,
        original: { sources: state.sources?.length || 0, edges: state.edges?.length || 0, runs: state.runs?.length || 0, jobs: state.jobs?.length || 0 },
      },
    },
    sources,
    edges,
    runs,
    jobs,
  };
  while (jobs.length > 0 && Buffer.byteLength(JSON.stringify({ ...base, edges, jobs })) > limits.bytes) {
    jobs = jobs.slice(0, -1);
    edges = edgesForJobs(jobs);
  }
  const output = { ...base, edges, jobs };
  output.metadata.hostedProjection.selected = { sources: sources.length, edges: edges.length, runs: runs.length, jobs: jobs.length };
  output.metadata.hostedProjection.truncated = {
    sources: Math.max(0, (state.sources?.length || 0) - sources.length),
    edges: Math.max(0, (state.edges?.length || 0) - edges.length),
    runs: Math.max(0, (state.runs?.length || 0) - runs.length),
    jobs: Math.max(0, (state.jobs?.length || 0) - jobs.length),
  };
  output.metadata.hostedProjection.replacementMode = "complete_snapshot";
  output.metadata.hostedProjection.warnings = jobs.length === 0
    ? ["EMPTY_JOB_PROJECTION_WILL_CLEAR_HOSTED_JOBS_AFTER_D1_INITIALIZATION"]
    : [];
  output.metadata.hostedProjection.bytes = 0;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (output.metadata.hostedProjection.bytes === bytes) break;
    output.metadata.hostedProjection.bytes = bytes;
  }
  if (output.metadata.hostedProjection.bytes > limits.bytes) {
    throw Object.assign(new Error(`托管投影 ${output.metadata.hostedProjection.bytes} 字节，超过 ${limits.bytes} 字节安全上限`), { code: "HOSTED_PROJECTION_TOO_LARGE" });
  }
  return output;
}
