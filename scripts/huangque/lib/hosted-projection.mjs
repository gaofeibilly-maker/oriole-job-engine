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

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
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

export function buildHostedProjection(state, { limits = HOSTED_PROJECTION_LIMITS, generatedAt = new Date().toISOString() } = {}) {
  if (!state || state.schemaVersion !== "huangque.registry.v1") throw new TypeError("huangque.registry.v1 snapshot required");
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
  const sourceRoots = new Map(selectedSources.map((source) => [source.id, source.candidate?.sourceRootUrl]).filter(([, root]) => root));
  const projectedJobs = (state.jobs || []).flatMap((job) => {
    const resolved = resolveHostedJob(job, activeSourceIds, sourceRoots, generatedAt);
    if (!resolved.sourceId || ["closed", "quarantined"].includes(resolved.job.status)) return [];
    const compact = compactJob(resolved.job, selectedSourceIds);
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
      .filter((edge) => edge.type !== "lists_job" || selectedJobIds.has(String(edge.to || "").replace(/^job:/, "")))
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
        policy: "approved/reviewable sources first; displayable jobs by status, score and observation time",
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
