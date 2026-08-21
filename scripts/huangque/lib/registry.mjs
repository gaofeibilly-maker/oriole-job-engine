import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { canonicalizeUrl } from "./source-discovery.mjs";
import { jobsCanExactMerge, sameSourceExternalIdConflict, softJobIdentity } from "./job-identity.mjs";
import { registerOperationRun, throwIfOperationAborted } from "./operation-context.mjs";

export const REGISTRY_SCHEMA_VERSION = "huangque.registry.v1";
export const REGISTRY_RETENTION = Object.freeze({
  runs: 50,
  events: 1_000,
  sourceRunIds: 50,
  jobEvidence: 48,
  recentJobVersions: 2_000,
});

const CANDIDATE_RETENTION = Object.freeze({
  queryIds: 200,
  evidence: 50,
  discoveredUrls: 100,
  titles: 50,
  reasonCodes: 50,
});

const CANDIDATE_STATUS_STRENGTH = Object.freeze({
  rejected_access_restricted: 1,
  backlog: 2,
  needs_review: 3,
  ready_for_probe: 4,
  already_registered: 5,
});

const CANDIDATE_AUTHORITY_STRENGTH = Object.freeze({
  unknown: 0,
  needs_domain_ownership_check: 1,
  needs_publisher_ownership_check: 1,
  employer_controlled_board: 3,
  official_public_service: 4,
  official_government: 4,
  official_government_directory: 4,
  official_employer: 4,
});

function candidateStatusStrength(value) {
  return Number(CANDIDATE_STATUS_STRENGTH[String(value || "")] || 0);
}

function candidateAuthorityStrength(value) {
  const normalized = String(value || "");
  if (Object.hasOwn(CANDIDATE_AUTHORITY_STRENGTH, normalized)) return CANDIDATE_AUTHORITY_STRENGTH[normalized];
  if (/^official_/.test(normalized)) return 4;
  return 0;
}

function boundedRecentUnique(values, limit, keyOf = (value) => String(value)) {
  const selected = [];
  const seen = new Set();
  for (let index = values.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const value = values[index];
    if (value === null || value === undefined || value === "") continue;
    let key;
    try { key = keyOf(value); } catch { key = String(value); }
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(value);
  }
  return selected.reverse();
}

function mergeUnapprovedCandidate(current = {}, incoming = {}) {
  const currentStatusStrength = candidateStatusStrength(current.status);
  const incomingStatusStrength = candidateStatusStrength(incoming.status);
  const incomingCarriesStatus = incomingStatusStrength >= currentStatusStrength;
  const base = incomingCarriesStatus ? { ...current, ...incoming } : { ...incoming, ...current };
  const status = incomingCarriesStatus ? incoming.status || current.status : current.status || incoming.status;
  const authority = !current.authority
    || candidateAuthorityStrength(incoming.authority) > candidateAuthorityStrength(current.authority)
    ? incoming.authority || current.authority
    : current.authority || incoming.authority;
  const priorityValues = [current.discoveryPriorityScore, incoming.discoveryPriorityScore]
    .map(Number)
    .filter(Number.isFinite);
  const decisionOwner = incomingCarriesStatus ? incoming.decision : current.decision;
  const fallbackDecision = incomingCarriesStatus ? current.decision : incoming.decision;
  return {
    ...base,
    id: current.id || incoming.id,
    sourceKey: current.sourceKey || incoming.sourceKey,
    status,
    authority,
    discoveryPriorityScore: priorityValues.length ? Math.max(...priorityValues) : base.discoveryPriorityScore,
    queryIds: boundedRecentUnique([...(current.queryIds || []), ...(incoming.queryIds || [])], CANDIDATE_RETENTION.queryIds),
    evidence: boundedRecentUnique(
      [...(current.evidence || []), ...(incoming.evidence || [])],
      CANDIDATE_RETENTION.evidence,
      (value) => JSON.stringify(value),
    ),
    discoveredUrls: boundedRecentUnique([...(current.discoveredUrls || []), ...(incoming.discoveredUrls || [])], CANDIDATE_RETENTION.discoveredUrls),
    titles: boundedRecentUnique([...(current.titles || []), ...(incoming.titles || [])], CANDIDATE_RETENTION.titles),
    decision: {
      ...(fallbackDecision || {}),
      ...(decisionOwner || {}),
      status,
      reasonCodes: boundedRecentUnique(
        [...(current.decision?.reasonCodes || []), ...(incoming.decision?.reasonCodes || [])],
        CANDIDATE_RETENTION.reasonCodes,
      ),
    },
    nextAction: incomingCarriesStatus
      ? incoming.nextAction || current.nextAction || null
      : current.nextAction || incoming.nextAction || null,
  };
}

function nowIso(now = new Date()) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("now 必须是有效时间");
  return date.toISOString();
}

function stableEventId(type, payload, at) {
  return `event-${createHash("sha256").update(`${type}\0${at}\0${JSON.stringify(payload)}`).digest("hex").slice(0, 16)}`;
}

function graphTarget(type, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^(?:publisher|provider|region|endpoint|entry|job):/.test(raw)) return raw;
  return `${type}:${raw}`;
}

function upsertGraphEdge(state, { from, to, type, toType = null, evidence = null, runId = null, verified = false }, at) {
  if (!from || !to || !type) return null;
  const key = `${from}\0${type}\0${to}`;
  const normalizedEvidence = evidence && typeof evidence === "object" && Object.keys(evidence).length
    ? evidence
    : { kind: "deterministic_registry_observation", sourceId: from };
  const existing = state.edges.find((item) => item.key === key);
  if (existing) {
    existing.lastObservedAt = at;
    existing.lastVerifiedAt = verified ? at : existing.lastVerifiedAt || null;
    existing.verificationState = verified ? "verified" : existing.verificationState || "observed";
    existing.observationCount = Number(existing.observationCount || 1) + 1;
    existing.latestObservation = normalizedEvidence;
    if (verified || existing.verificationState !== "verified") existing.evidence = normalizedEvidence;
    if (verified) existing.verifiedEvidence = normalizedEvidence;
    if (runId) existing.runId = runId;
    return existing;
  }
  const edge = {
    id: `edge-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
    key,
    from,
    fromType: "source",
    to,
    toType: toType || String(to).split(":", 1)[0] || "resource",
    type,
    evidence: normalizedEvidence,
    verifiedEvidence: verified ? normalizedEvidence : null,
    latestObservation: normalizedEvidence,
    observationCount: 1,
    firstObservedAt: at,
    lastObservedAt: at,
    lastVerifiedAt: verified ? at : null,
    verificationState: verified ? "verified" : "observed",
    runId,
  };
  state.edges.push(edge);
  return edge;
}

function candidateGraphEdges(candidate, runId = null) {
  const firstEvidence = candidate.evidence?.[0] || {};
  const publisher = candidate.publisher || firstEvidence.providerEvidence?.publisher || candidate.tenant;
  const edges = [];
  if (publisher) edges.push({
    type: "published_by",
    to: graphTarget("publisher", publisher),
    toType: "publisher",
    runId,
    evidence: { kind: "candidate_publisher", publisher, sourceUrl: candidate.sourceRootUrl, observation: firstEvidence },
  });
  for (const region of candidate.regions || []) edges.push({
    type: "covers_region",
    to: graphTarget("region", `${region.provinceCode || "CN"}:${region.cityCode || "ALL"}`),
    toType: "region",
    runId,
    evidence: { kind: "candidate_region", region, scopeSignals: candidate.scopeSignals || [], observation: firstEvidence },
  });
  if (candidate.entryUrl) edges.push({
    type: "has_entry_point",
    to: graphTarget("entry", candidate.entryUrl),
    toType: "entry",
    runId,
    evidence: { kind: "candidate_entry", url: candidate.entryUrl, observation: firstEvidence },
  });
  if (candidate.publicApiUrl) edges.push({
    type: "has_endpoint",
    to: graphTarget("endpoint", candidate.publicApiUrl),
    toType: "endpoint",
    runId,
    evidence: { kind: "candidate_endpoint", url: candidate.publicApiUrl, provider: candidate.provider, observation: firstEvidence },
  });
  const channels = new Map();
  for (const observation of candidate.evidence || []) {
    if (!observation.channel) continue;
    if (!channels.has(observation.channel)) channels.set(observation.channel, observation);
  }
  for (const [channel, observation] of channels) edges.push({
    type: "discovered_via",
    to: graphTarget("provider", channel),
    toType: "provider",
    runId,
    evidence: { kind: "discovery_observation", channel, queryId: observation.queryId, query: observation.query, url: observation.url, providerEvidence: observation.providerEvidence || null },
  });
  return edges;
}

export function createEmptyRegistry(now = new Date()) {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    revision: 0,
    metadata: {
      project: "黄雀",
      definition: "岗位垂类的信息源归集引擎",
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      retention: { policy: REGISTRY_RETENTION, pruned: {}, lastAppliedAt: null },
    },
    bucketState: {},
    sources: [],
    edges: [],
    runs: [],
    jobs: [],
    jobVersions: [],
    duplicateCandidates: [],
    providerBudgets: {},
    events: [],
  };
}

export function validateRegistry(state) {
  if (!state || state.schemaVersion !== REGISTRY_SCHEMA_VERSION) throw new TypeError(`来源库必须符合 ${REGISTRY_SCHEMA_VERSION}`);
  for (const field of ["sources", "edges", "runs", "jobs", "events"]) {
    if (!Array.isArray(state[field])) throw new TypeError(`来源库 ${field} 必须是数组`);
  }
  if (!Array.isArray(state.duplicateCandidates)) state.duplicateCandidates = [];
  if (!Array.isArray(state.jobVersions)) state.jobVersions = [];
  if (!state.providerBudgets || typeof state.providerBudgets !== "object" || Array.isArray(state.providerBudgets)) state.providerBudgets = {};
  if (!state.bucketState || typeof state.bucketState !== "object") throw new TypeError("来源库 bucketState 必须是对象");
  if (!state.metadata.retention || typeof state.metadata.retention !== "object") {
    state.metadata.retention = { policy: REGISTRY_RETENTION, pruned: {}, lastAppliedAt: null };
  }
  const normalizedEdges = new Map();
  for (const original of state.edges) {
    const edge = { ...original };
    if (edge.type === "collection_endpoint") edge.type = "has_endpoint";
    if (!/^(?:publisher|provider|region|endpoint|entry|job):/.test(String(edge.to || ""))) {
      edge.to = graphTarget(edge.type === "lists_job" ? "job" : "endpoint", edge.to);
    }
    edge.key = `${edge.from}\0${edge.type}\0${edge.to}`;
    edge.id = `edge-${createHash("sha256").update(edge.key).digest("hex").slice(0, 16)}`;
    edge.fromType ||= "source";
    edge.toType ||= String(edge.to).split(":", 1)[0] || "resource";
    edge.evidence = edge.evidence && typeof edge.evidence === "object" && Object.keys(edge.evidence).length
      ? edge.evidence
      : { kind: "legacy_registry_migration", originalRelationType: original.type, sourceId: edge.from };
    edge.verificationState ||= edge.lastVerifiedAt ? "verified" : "observed";
    edge.lastVerifiedAt ||= null;
    edge.verifiedEvidence ||= edge.verificationState === "verified" ? edge.evidence : null;
    edge.latestObservation ||= edge.evidence;
    edge.observationCount = Math.max(1, Number(edge.observationCount || 1));
    const previous = normalizedEdges.get(edge.key);
    if (!previous || String(edge.lastObservedAt || "") > String(previous.lastObservedAt || "")) normalizedEdges.set(edge.key, edge);
  }
  state.edges = [...normalizedEdges.values()];
  const currentPublisherTargets = new Map(state.sources
    .filter((source) => source?.candidate?.publisher)
    .map((source) => [source.id, graphTarget("publisher", source.candidate.publisher)]));
  state.edges = state.edges.filter((edge) => {
    if (edge.type !== "published_by") return true;
    const current = currentPublisherTargets.get(edge.from);
    return !current || edge.to === current;
  });
  return state;
}

function clone(value) {
  return structuredClone(value);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function addPruned(state, field, count) {
  if (count <= 0) return;
  const pruned = state.metadata.retention.pruned ||= {};
  pruned[field] = Number(pruned[field] || 0) + count;
}

function compactEvidence(evidence, activeRunIds) {
  const valid = (Array.isArray(evidence) ? evidence : []).flatMap((item) => {
    if (!item?.runId || activeRunIds.has(item.runId)) return [item];
    if (item.kind === "collection_artifact") return [{ ...item, runId: null, runArchived: true }];
    return [];
  });
  if (valid.length <= REGISTRY_RETENTION.jobEvidence) return valid;
  const selected = new Set();
  const criticalKeys = new Set();
  const criticalKinds = new Set(["collection_artifact", "source_support_revoked", "source_projection_fallback"]);
  for (let index = valid.length - 1; index >= 0 && selected.size < REGISTRY_RETENTION.jobEvidence; index -= 1) {
    const item = valid[index];
    if (!criticalKinds.has(item?.kind)) continue;
    const key = `${item.kind}:${item.sourceId || ""}`;
    if (criticalKeys.has(key)) continue;
    criticalKeys.add(key);
    selected.add(index);
  }
  for (let index = valid.length - 1; index >= 0 && selected.size < REGISTRY_RETENTION.jobEvidence; index -= 1) selected.add(index);
  return valid.filter((_, index) => selected.has(index));
}

function applyRegistryRetention(state, at) {
  const previousRunCount = state.runs.length;
  state.runs = state.runs.slice(0, REGISTRY_RETENTION.runs);
  addPruned(state, "runs", previousRunCount - state.runs.length);
  const activeRunIds = new Set(state.runs.map((run) => run.id));

  for (const source of state.sources) {
    const previous = Array.isArray(source.runIds) ? source.runIds : [];
    source.runIds = previous.filter((runId) => activeRunIds.has(runId)).slice(0, REGISTRY_RETENTION.sourceRunIds);
    addPruned(state, "sourceRunIds", previous.length - source.runIds.length);
  }
  for (const job of state.jobs) {
    const previous = Array.isArray(job.evidence) ? job.evidence : [];
    job.evidence = compactEvidence(previous, activeRunIds);
    addPruned(state, "jobEvidence", previous.length - job.evidence.length);
  }

  const previousEvents = state.events.length;
  state.events = state.events.filter((event) => !event.runId || activeRunIds.has(event.runId)).slice(0, REGISTRY_RETENTION.events);
  addPruned(state, "events", previousEvents - state.events.length);

  const previousVersions = state.jobVersions.length;
  const latestVersionIndex = new Map();
  state.jobVersions.forEach((version, index) => latestVersionIndex.set(version.jobId, index));
  const selected = new Set(latestVersionIndex.values());
  const versionTarget = Math.max(REGISTRY_RETENTION.recentJobVersions, selected.size);
  for (let index = state.jobVersions.length - 1; index >= 0 && selected.size < versionTarget; index -= 1) selected.add(index);
  state.jobVersions = state.jobVersions.filter((_, index) => selected.has(index));
  addPruned(state, "jobVersions", previousVersions - state.jobVersions.length);

  state.metadata.retention.policy = REGISTRY_RETENTION;
  state.metadata.retention.lastAppliedAt = at;
}

function supportedJobStatus(sourceIds, sourceObservations = {}) {
  const ids = sourceIds || [];
  const missing = ids.map((id) => Number(sourceObservations[id]?.consecutiveMissing || 0));
  const observedClosed = ids.map((id) => sourceObservations[id]?.observedStatus === "closed");
  const observedNeedsReview = ids.some((id) => sourceObservations[id]?.observedStatus === "needs_review"
    || ["source_health_degraded", "source_unreachable", "source_data_conflict"].includes(sourceObservations[id]?.healthState));
  const closed = ids.map((id, index) => observedClosed[index]
    || missing[index] >= Number(sourceObservations[id]?.closureThreshold || 2));
  if (ids.length > 0 && closed.every(Boolean)) return "closed";
  if (observedNeedsReview || observedClosed.some(Boolean) || missing.length > 0 && missing.every((count) => count >= 1)) return "needs_review";
  return "confirmed_active";
}

function sourceProjection(job) {
  return Object.fromEntries([
    "externalId", "company", "title", "location", "department", "employmentType", "workplaceType", "salary",
    "locationRaw", "workLocations", "regions", "regionProvince", "regionProvinceCode", "regionCity", "regionCityCode", "regionLabel", "locationConfidence", "locationBasis",
    "sourceUrl", "applyUrl", "publishedAt", "validThrough", "description", "freshness", "freshnessState",
    "activeScore", "authenticityScore", "channelScore", "parser", "contentHash", "urlIdentity",
  ].filter((key) => Object.hasOwn(job, key)).map((key) => [key, job[key]]));
}

function sourceIdentityViews(job) {
  const observations = job?.sourceObservations && typeof job.sourceObservations === "object" && !Array.isArray(job.sourceObservations)
    ? job.sourceObservations
    : {};
  const sourceIds = [...new Set([job?.sourceId, ...(job?.sourceIds || []), ...Object.keys(observations)].filter(Boolean))];
  return sourceIds.map((sourceId) => {
    const projection = observations[sourceId]?.projection;
    return projection && typeof projection === "object" && !Array.isArray(projection)
      ? { ...job, ...projection, sourceId }
      : { ...job, sourceId };
  });
}

function applySupportedSourceProjection(state, job, sourceId) {
  const projection = job.sourceObservations?.[sourceId]?.projection;
  if (projection && typeof projection === "object") {
    Object.assign(job, projection);
    return true;
  }
  const fallbackRoot = state.sources.find((source) => source.id === sourceId)?.candidate?.sourceRootUrl;
  if (fallbackRoot) job.sourceUrl = fallbackRoot;
  return false;
}

function reconcileJobSupport(state, sourceId, at, reason) {
  const activeSourceIds = new Set(state.sources.filter((source) => source.lifecycle === "approved" && source.collectionEnabled).map((source) => source.id));
  for (const job of state.jobs.filter((item) => (item.sourceIds || [item.sourceId]).includes(sourceId))) {
    const priorSourceIds = job.sourceIds || [job.sourceId];
    const activeSupport = priorSourceIds.filter((id) => id !== sourceId && activeSourceIds.has(id));
    job.sourceIds = activeSupport;
    if (job.sourceObservations && typeof job.sourceObservations === "object") delete job.sourceObservations[sourceId];
    job.evidence = [...(job.evidence || []), { kind: "source_support_revoked", sourceId, reason, observedAt: at }];
    job.updatedAt = at;
    if (activeSupport.length > 0) {
      if (!activeSupport.includes(job.sourceId)) {
        job.sourceId = activeSupport[0];
      }
      if (!applySupportedSourceProjection(state, job, job.sourceId)) {
        job.evidence.push({ kind: "source_projection_fallback", sourceId: job.sourceId, observedAt: at });
      }
      const counts = activeSupport.map((id) => Number(job.sourceObservations?.[id]?.consecutiveMissing || 0));
      job.consecutiveMissing = counts.length ? Math.min(...counts) : 0;
      job.status = supportedJobStatus(activeSupport, job.sourceObservations);
      job.activeScore = Math.max(...activeSupport.map((id) => Number(job.sourceObservations?.[id]?.activeScore || 0)));
      const statusConflict = activeSupport.some((id) => job.sourceObservations?.[id]?.observedStatus === "closed")
        && activeSupport.some((id) => job.sourceObservations?.[id]?.observedStatus !== "closed");
      if (statusConflict) {
        job.validThrough = null;
        job.freshness = "来源有效期冲突，需复核";
        job.freshnessState = "source_validity_conflict";
      }
      continue;
    }
    job.status = "quarantined";
  }
}

export class JsonRegistry {
  constructor(path, { now = () => new Date() } = {}) {
    if (!path) throw new TypeError("JsonRegistry 需要文件路径");
    this.path = path;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return validateRegistry(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return createEmptyRegistry(this.now());
      throw error;
    }
  }

  async write(state) {
    throwIfOperationAborted();
    validateRegistry(state);
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      throwIfOperationAborted();
      await rename(tempPath, this.path);
    } finally {
      await unlink(tempPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
  }

  async acquireFileLock({ timeoutMs = 8_000, staleMs = 30_000 } = {}) {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        const token = randomUUID();
        const owner = { pid: process.pid, hostname: hostname(), token, acquiredAt: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        let heartbeat = Promise.resolve();
        const heartbeatInterval = setInterval(() => {
          heartbeat = heartbeat.then(async () => {
            let current;
            try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { return; }
            if (current?.token !== token) return;
            const now = new Date();
            await utimes(lockPath, now, now).catch(() => undefined);
          });
        }, Math.max(5, Math.floor(staleMs / 3)));
        heartbeatInterval.unref?.();
        return async () => {
          clearInterval(heartbeatInterval);
          await heartbeat.catch(() => undefined);
          await handle.close().catch(() => undefined);
          let current;
          try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch (error) {
            if (error?.code === "ENOENT") return;
            throw error;
          }
          if (current?.token !== token) return;
          await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > staleMs) {
            let owner = null;
            try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { owner = null; }
            let ownerAlive = false;
            if (owner?.hostname === hostname() && Number.isInteger(owner?.pid)) {
              try { process.kill(owner.pid, 0); ownerAlive = true; } catch (processError) { ownerAlive = processError?.code === "EPERM"; }
            }
            if (!ownerAlive) {
              const currentStat = await stat(lockPath);
              if (currentStat.mtimeMs === lockStat.mtimeMs) {
                let currentOwner = null;
                try { currentOwner = JSON.parse(await readFile(lockPath, "utf8")); } catch { currentOwner = null; }
                if (!owner?.token || currentOwner?.token === owner.token) {
                  await unlink(lockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
                  continue;
                }
              }
            }
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw Object.assign(new Error("来源库正被另一个进程写入，等待锁超时"), { code: "REGISTRY_LOCK_TIMEOUT" });
        await delay(15 + Math.floor(Math.random() * 35));
      }
    }
  }

  transaction(mutator, lockOptions = undefined) {
    const operation = this.queue.then(async () => {
      throwIfOperationAborted();
      const release = await this.acquireFileLock(lockOptions);
      try {
        throwIfOperationAborted();
        const state = clone(await this.read());
        const at = nowIso(this.now());
        const output = await mutator(state, at);
        throwIfOperationAborted();
        state.revision += 1;
        state.metadata.updatedAt = at;
        applyRegistryRetention(state, at);
        await this.write(state);
        return clone(output);
      } finally {
        await release();
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async snapshot() {
    return clone(await this.read());
  }

  async createRun(kind, input = {}) {
    const run = await this.transaction((state, at) => {
      const run = {
        id: `run-${randomUUID()}`,
        kind,
        status: "running",
        createdAt: at,
        updatedAt: at,
        completedAt: null,
        input,
        stats: {},
        providerRuns: [],
        errors: [],
      };
      state.runs.unshift(run);
      state.events.unshift({ id: stableEventId("run_created", { runId: run.id }, at), type: "run_created", at, runId: run.id });
      return run;
    });
    registerOperationRun(run.id);
    return run;
  }

  async cancelRuns(runIds, reason = { code: "TOOL_DEADLINE_EXCEEDED", message: "MCP 工具已超过执行时限" }) {
    const ids = new Set((runIds || []).filter((runId) => typeof runId === "string" && runId));
    if (ids.size === 0) return [];
    return this.transaction((state, at) => {
      const cancelled = [];
      for (const run of state.runs) {
        if (!ids.has(run.id) || run.status !== "running") continue;
        run.status = "cancelled";
        run.updatedAt = at;
        run.completedAt = at;
        run.errors = [...(run.errors || []), { code: reason.code || "OPERATION_CANCELLED", message: reason.message || "操作已取消" }];
        state.events.unshift({ id: stableEventId("run_cancelled", { runId: run.id }, at), type: "run_cancelled", at, runId: run.id, reason: reason.code || "OPERATION_CANCELLED" });
        cancelled.push(run.id);
      }
      return cancelled;
    });
  }

  async finishRun(runId, { status = "completed", stats = {}, providerRuns = [], errors = [], output = {} } = {}) {
    return this.transaction((state, at) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw Object.assign(new Error(`运行不存在：${runId}`), { code: "RUN_NOT_FOUND" });
      run.status = status;
      run.updatedAt = at;
      run.completedAt = at;
      run.stats = stats;
      run.providerRuns = providerRuns;
      run.errors = errors;
      run.output = output;
      state.events.unshift({ id: stableEventId("run_finished", { runId, status }, at), type: "run_finished", at, runId, status });
      return run;
    });
  }

  async getRun(runId) {
    const state = await this.read();
    return clone(state.runs.find((run) => run.id === runId) || null);
  }

  async upsertCandidates(discovery, runId = null) {
    return this.transaction((state, at) => {
      const touched = [];
      for (const candidate of discovery.candidates || []) {
        let source = state.sources.find((item) => item.sourceKey === candidate.sourceKey);
        if (!source) {
          const persistedCandidate = mergeUnapprovedCandidate({}, candidate);
          source = {
            id: persistedCandidate.id,
            revision: 1,
            sourceKey: persistedCandidate.sourceKey,
            name: persistedCandidate.name,
            lifecycle: "candidate",
            reviewStatus: "unreviewed",
            verificationState: "unverified_candidate",
            collectionEnabled: false,
            discoveredAt: at,
            lastDiscoveredAt: at,
            lastProbedAt: null,
            approvedAt: null,
            rejectedAt: null,
            candidate: persistedCandidate,
            probe: null,
            review: null,
            collection: null,
            runIds: runId ? [runId] : [],
          };
          state.sources.push(source);
          state.events.unshift({ id: stableEventId("source_discovered", { sourceId: source.id }, at), type: "source_discovered", at, runId, sourceId: source.id });
        } else {
          source.revision += 1;
          source.lastDiscoveredAt = at;
          if (source.lifecycle === "approved") {
            source.candidate = {
              ...source.candidate,
              latestPublishedAt: candidate.latestPublishedAt || source.candidate?.latestPublishedAt || null,
              queryIds: [...new Set([...(source.candidate?.queryIds || []), ...(candidate.queryIds || [])])],
              discoveredUrls: [...new Set([...(source.candidate?.discoveredUrls || []), ...(candidate.discoveredUrls || [])])],
              evidence: [...(source.candidate?.evidence || []), ...(candidate.evidence || [])].slice(-50),
            };
          } else {
            source.candidate = mergeUnapprovedCandidate(source.candidate, candidate);
            source.name = source.candidate.name || source.name;
          }
          if (runId && !source.runIds.includes(runId)) source.runIds.unshift(runId);
        }
        for (const edge of candidateGraphEdges(candidate, runId)) upsertGraphEdge(state, { from: source.id, ...edge }, at);
        touched.push(source);
      }
      return { sources: touched, insertedOrUpdated: touched.length };
    });
  }

  async recordProbe(sourceId, probe, runId = null) {
    return this.transaction((state, at) => {
      const source = state.sources.find((item) => item.id === sourceId);
      if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
      const remainedApproved = source.lifecycle === "approved" && probe.verificationState === "verified";
      source.revision += 1;
      source.lifecycle = remainedApproved ? "approved" : "probed";
      source.verificationState = probe.verificationState;
      source.reviewStatus = remainedApproved ? "approved" : probe.verificationState === "verified" ? "pending" : "blocked";
      source.collectionEnabled = remainedApproved;
      source.lastProbedAt = at;
      source.probe = probe;
      if (!remainedApproved) reconcileJobSupport(state, sourceId, at, `probe_${probe.verificationState}`);
      if (runId && !source.runIds.includes(runId)) source.runIds.unshift(runId);
      for (const edge of probe.edges || []) {
        upsertGraphEdge(state, {
          from: source.id,
          to: graphTarget(edge.type === "lists_job" ? "job" : "endpoint", edge.to),
          toType: edge.type === "lists_job" ? "job" : "endpoint",
          type: edge.type === "collection_endpoint" ? "has_endpoint" : edge.type,
          evidence: edge.evidence,
          runId,
          verified: probe.verificationState === "verified",
        }, at);
      }
      for (const edge of candidateGraphEdges(source.candidate, runId)) upsertGraphEdge(state, { from: source.id, ...edge, verified: probe.verificationState === "verified" }, at);
      state.events.unshift({ id: stableEventId("source_probed", { sourceId, verificationState: probe.verificationState }, at), type: "source_probed", at, runId, sourceId, verificationState: probe.verificationState });
      return source;
    });
  }

  async reviewSource(sourceId, {
    decision,
    reason,
    reviewedBy,
    expectedRevision,
    confirmation = false,
  }) {
    if (!confirmation) throw Object.assign(new Error("review_source 需要 confirmation=true"), { code: "CONFIRMATION_REQUIRED" });
    if (!reviewedBy || !reason) throw Object.assign(new Error("审核必须包含 reviewedBy 与 reason"), { code: "REVIEW_EVIDENCE_REQUIRED" });
    if (!["approve", "reject"].includes(decision)) throw Object.assign(new Error("decision 必须是 approve 或 reject"), { code: "INVALID_DECISION" });
    return this.transaction((state, at) => {
      const source = state.sources.find((item) => item.id === sourceId);
      if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
      if (Number(expectedRevision) !== source.revision) {
        throw Object.assign(new Error(`来源版本冲突：期望 ${expectedRevision}，实际 ${source.revision}`), { code: "REVISION_CONFLICT", actualRevision: source.revision });
      }
      if (decision === "approve" && source.verificationState !== "verified") {
        throw Object.assign(new Error("只有真实探测通过的来源才能批准"), { code: "SOURCE_NOT_VERIFIED" });
      }
      source.revision += 1;
      source.lifecycle = decision === "approve" ? "approved" : "rejected";
      source.reviewStatus = decision === "approve" ? "approved" : "rejected";
      source.collectionEnabled = decision === "approve";
      source.approvedAt = decision === "approve" ? at : null;
      source.rejectedAt = decision === "reject" ? at : null;
      source.review = { decision, reason, reviewedBy, reviewedAt: at };
      if (decision === "reject") reconcileJobSupport(state, sourceId, at, "human_reject");
      state.events.unshift({ id: stableEventId("source_reviewed", { sourceId, decision }, at), type: "source_reviewed", at, sourceId, decision, reviewedBy, reason });
      return source;
    });
  }

  async importApprovedSource(candidate, {
    reviewedBy = "existing_snapshot_bootstrap",
    reason = "该来源已在现有岗位快照中运行并保留证据",
    probe,
  } = {}) {
    return this.transaction((state, at) => {
      let source = state.sources.find((item) => item.sourceKey === candidate.sourceKey);
      if (source?.lifecycle === "approved") {
        source.revision += 1;
        source.name = candidate.name || source.name;
        source.lastDiscoveredAt = at;
        source.candidate = { ...source.candidate, ...candidate };
        if (candidate.publisher) {
          const publisherTarget = graphTarget("publisher", candidate.publisher);
          state.edges = state.edges.filter((edge) => edge.from !== source.id || edge.type !== "published_by" || edge.to === publisherTarget);
        }
        if (candidate.regions?.length) {
          const currentRegionTargets = new Set(candidate.regions.map((region) => graphTarget("region", `${region.provinceCode || "CN"}:${region.cityCode || "ALL"}`)));
          state.edges = state.edges.filter((edge) => edge.from !== source.id || edge.type !== "covers_region" || currentRegionTargets.has(edge.to));
        }
        for (const edge of candidateGraphEdges(source.candidate)) upsertGraphEdge(state, { from: source.id, ...edge, verified: true }, at);
        return source;
      }
      if (!source) {
        source = {
          id: candidate.id,
          revision: 0,
          sourceKey: candidate.sourceKey,
          name: candidate.name,
          discoveredAt: at,
          lastDiscoveredAt: at,
          lastProbedAt: at,
          candidate,
          runIds: [],
        };
        state.sources.push(source);
      }
      source.revision += 1;
      source.lifecycle = "approved";
      source.reviewStatus = "approved";
      source.verificationState = "verified";
      source.collectionEnabled = true;
      source.probe = probe || { verificationState: "verified", strategy: "existing_snapshot_evidence", probedAt: at, evidence: [] };
      source.review = { decision: "approve", reason, reviewedBy, reviewedAt: at };
      source.approvedAt = at;
      source.rejectedAt = null;
      for (const edge of candidateGraphEdges(candidate)) upsertGraphEdge(state, { from: source.id, ...edge, verified: true }, at);
      for (const edge of source.probe?.edges || []) {
        upsertGraphEdge(state, {
          from: source.id,
          to: graphTarget(edge.type === "lists_job" ? "job" : "endpoint", edge.to),
          toType: edge.type === "lists_job" ? "job" : "endpoint",
          type: edge.type === "collection_endpoint" ? "has_endpoint" : edge.type,
          evidence: edge.evidence,
          verified: true,
        }, at);
      }
      state.events.unshift({ id: stableEventId("source_bootstrapped", { sourceId: source.id }, at), type: "source_bootstrapped", at, sourceId: source.id, reviewedBy, reason });
      return source;
    });
  }

  async updateDiscoveryProgress(completedTaskIds, allTasks, runId = null) {
    return this.transaction((state, at) => {
      const taskToBucket = new Map((allTasks || []).map((task) => [task.id, task.bucketId]));
      const tasksByBucket = new Map();
      for (const task of allTasks || []) {
        const ids = tasksByBucket.get(task.bucketId) || [];
        ids.push(task.id);
        tasksByBucket.set(task.bucketId, ids);
      }
      const newlyCompletedByBucket = new Map();
      for (const taskId of new Set(completedTaskIds || [])) {
        const bucketId = taskToBucket.get(taskId);
        if (!bucketId) continue;
        const ids = newlyCompletedByBucket.get(bucketId) || [];
        ids.push(taskId);
        newlyCompletedByBucket.set(bucketId, ids);
      }
      const completedBucketIds = [];
      const progress = {};
      for (const [bucketId, newlyCompleted] of newlyCompletedByBucket) {
        const allIds = tasksByBucket.get(bucketId) || [];
        const allIdSet = new Set(allIds);
        const previous = state.bucketState[bucketId] || {};
        const accumulated = [...new Set([...(previous.completedTaskIds || []), ...newlyCompleted])]
          .filter((taskId) => allIdSet.has(taskId));
        if (allIds.length > 0 && allIds.every((taskId) => accumulated.includes(taskId))) {
          state.bucketState[bucketId] = { lastCompletedAt: at, lastProgressAt: at, completedTaskIds: [], runId };
          completedBucketIds.push(bucketId);
        } else {
          state.bucketState[bucketId] = { ...previous, lastProgressAt: at, completedTaskIds: accumulated, runId };
        }
        progress[bucketId] = { completed: state.bucketState[bucketId].completedTaskIds.length, total: allIds.length, cycleCompleted: completedBucketIds.includes(bucketId) };
      }
      return { bucketState: state.bucketState, completedBucketIds, progress };
    });
  }

  async recordCollectionAttempt(sourceId, {
    runId = null,
    success,
    commit = false,
    cadenceHours = 12,
    error = null,
  }) {
    return this.transaction((state, at) => {
      const source = state.sources.find((item) => item.id === sourceId);
      if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
      const previous = source.collection || {};
      const dataIntegrityFailure = !success && ["JOB_IDENTITY_CONFLICT", "UNSAFE_JOB_ORIGIN"].includes(error?.code);
      const failures = success ? 0 : Number(previous.consecutiveFailures || 0) + 1;
      const baseDelayHours = success
        ? Math.max(1, Number(cadenceHours) || 12)
        : Math.min(Math.max(1, Number(cadenceHours) || 12), 2 ** Math.min(6, failures - 1));
      const jitterMinutes = Number.parseInt(createHash("sha256").update(`${sourceId}\0${at}`).digest("hex").slice(0, 4), 16) % 31;
      const nextDueAt = new Date(new Date(at).getTime() + baseDelayHours * 3_600_000 + jitterMinutes * 60_000).toISOString();
      source.revision += 1;
      source.collection = {
        ...previous,
        lastAttemptedAt: at,
        lastSuccessfulFetchAt: success ? at : previous.lastSuccessfulFetchAt || null,
        lastAttemptStatus: success ? "completed" : dataIntegrityFailure ? "data_integrity_failed" : "failed",
        lastAttemptCommitted: Boolean(commit),
        consecutiveFailures: failures,
        nextDueAt,
        runId,
        lastError: success ? null : error,
      };
      if (!success && (failures >= 2 || dataIntegrityFailure)) {
        const supportUnavailable = !dataIntegrityFailure && failures >= 4;
        for (const job of state.jobs.filter((item) => (item.sourceIds || [item.sourceId]).includes(sourceId))) {
          const sourceIds = job.sourceIds || [job.sourceId];
          job.sourceObservations = { ...(job.sourceObservations || {}) };
          for (const id of sourceIds) {
            if (!job.sourceObservations[id]) job.sourceObservations[id] = {
              consecutiveMissing: 0,
              lastObservedAt: id === job.sourceId ? job.lastObservedAt || job.observedAt || at : null,
              observedStatus: id === job.sourceId ? job.status || "confirmed_active" : "confirmed_active",
              validThrough: id === job.sourceId ? job.validThrough || null : null,
              activeScore: id === job.sourceId ? Number(job.activeScore || 0) : 0,
              projection: id === job.sourceId ? sourceProjection(job) : null,
            };
          }
          const current = job.sourceObservations[sourceId];
          const freshnessLabel = dataIntegrityFailure
            ? "来源数据违反已批准身份边界或岗位标识发生冲突，已停止提交并等待复核"
            : supportUnavailable
              ? `来源连续 ${failures} 次采集失败，该来源暂不可达，不能据此断言岗位关闭`
              : `来源连续 ${failures} 次采集失败，需复核`;
          const activeScore = supportUnavailable ? 0 : Math.min(Number(current.activeScore || 0), 50);
          job.sourceObservations[sourceId] = {
            ...current,
            healthState: dataIntegrityFailure ? "source_data_conflict" : supportUnavailable ? "source_unreachable" : "source_health_degraded",
            activeScore: current.observedStatus === "closed" ? 0 : activeScore,
            healthFailureCount: failures,
            lastHealthFailureAt: at,
            projection: current.projection && typeof current.projection === "object" ? {
              ...current.projection,
              freshness: freshnessLabel,
              freshnessState: dataIntegrityFailure ? "source_data_conflict" : supportUnavailable ? "source_unreachable" : "source_health_degraded",
              activeScore: current.observedStatus === "closed" ? 0 : activeScore,
            } : current.projection,
          };
          job.status = supportedJobStatus(sourceIds, job.sourceObservations);
          job.consecutiveMissing = Math.min(...sourceIds.map((id) => Number(job.sourceObservations[id]?.consecutiveMissing || 0)));
          job.activeScore = job.status === "closed" ? 0 : Math.max(...sourceIds.map((id) => Number(job.sourceObservations[id]?.activeScore || 0)));
          if (job.status !== "confirmed_active") {
            job.freshness = freshnessLabel;
            job.freshnessState = dataIntegrityFailure ? "source_data_conflict" : supportUnavailable ? "source_unreachable" : "source_health_degraded";
          }
          job.updatedAt = at;
          job.evidence = [...(job.evidence || []), {
            kind: "source_collection_health_degraded",
            sourceId,
            observedAt: at,
            consecutiveFailures: failures,
            supportUnavailable,
            dataIntegrityFailure,
            runId,
          }];
        }
      }
      state.events.unshift({
        id: stableEventId("collection_attempted", { sourceId, success: Boolean(success), runId }, at),
        type: "collection_attempted",
        at,
        runId,
        sourceId,
        success: Boolean(success),
        nextDueAt,
      });
      return source.collection;
    });
  }

  async reserveDailyProviderRequest(provider, { limit = 40, now = this.now() } = {}) {
    if (typeof provider !== "string" || !provider.trim()) throw new TypeError("provider 必须是非空字符串");
    const requestAt = new Date(now);
    if (Number.isNaN(requestAt.getTime())) throw new TypeError("now 必须是有效时间");
    const effectiveLimit = Math.max(1, Math.min(10_000, Math.floor(Number(limit) || 40)));
    const day = requestAt.toISOString().slice(0, 10);
    return this.transaction((state, at) => {
      state.providerBudgets ||= {};
      const previous = state.providerBudgets[provider];
      const used = previous?.day === day ? Math.max(0, Number(previous.used || 0)) : 0;
      if (used >= effectiveLimit) return { granted: false, provider, day, used, limit: effectiveLimit, remaining: 0 };
      const next = { day, used: used + 1, limit: effectiveLimit, updatedAt: at };
      state.providerBudgets[provider] = next;
      return { granted: true, provider, ...next, remaining: Math.max(0, effectiveLimit - next.used) };
    });
  }

  async storeJobs(sourceId, jobs, {
    commit = false,
    runId = null,
    allowMissingAdvance = true,
    markMissingNeedsReview = false,
    missingThreshold = 2,
  } = {}) {
    const state = await this.read();
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) throw Object.assign(new Error(`来源不存在：${sourceId}`), { code: "SOURCE_NOT_FOUND" });
    if (source.lifecycle !== "approved" || !source.collectionEnabled) {
      throw Object.assign(new Error("只有已批准且启用采集的来源才能收录岗位"), { code: "SOURCE_NOT_APPROVED" });
    }
    const existingIds = new Set(state.jobs.map((job) => job.id));
    const externalGroups = new Map();
    const existingSourceViews = state.jobs.flatMap(sourceIdentityViews).filter((item) => item.sourceId === sourceId);
    for (const job of [...existingSourceViews, ...jobs]) {
      if (job.externalId === null || job.externalId === undefined || job.externalId === "") continue;
      const key = `${job.sourceId}\0${String(job.externalId)}`;
      const group = externalGroups.get(key) || [];
      if (group.some((existing) => sameSourceExternalIdConflict(existing, job))) {
        throw Object.assign(new Error(`来源 ${sourceId} 的 externalId ${job.externalId} 对应互相冲突的岗位身份`), {
          code: "JOB_IDENTITY_CONFLICT",
          sourceId,
          externalId: job.externalId,
        });
      }
      group.push(job);
      externalGroups.set(key, group);
    }
    const preview = {
      sourceId,
      commit,
      received: jobs.length,
      new: jobs.filter((job) => !existingIds.has(job.id)).length,
      updated: jobs.filter((job) => existingIds.has(job.id)).length,
      jobs,
    };
    if (!commit) return preview;
    return this.transaction((draft, at) => {
      const currentSource = draft.sources.find((item) => item.id === sourceId);
      if (currentSource?.lifecycle !== "approved" || !currentSource.collectionEnabled) {
        throw Object.assign(new Error("来源批准状态已改变，拒绝提交"), { code: "SOURCE_NOT_APPROVED" });
      }
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      const observedIds = new Set();
      const idIndex = new Map();
      const externalIndex = new Map();
      const urlIdentityIndex = new Map();
      const addJobIndex = (candidate, index) => {
        idIndex.set(candidate.id, index);
        for (const view of sourceIdentityViews(candidate)) {
          if (view.externalId !== null && view.externalId !== undefined && view.externalId !== "") {
            const key = `${view.sourceId}\0${String(view.externalId)}`;
            const indexes = externalIndex.get(key) || new Set();
            indexes.add(index);
            externalIndex.set(key, indexes);
          }
          const applyUrl = canonicalizeUrl(view.applyUrl);
          if (applyUrl && view.urlIdentity !== "source_fallback") {
            const key = `${applyUrl}\0${softJobIdentity(view)}`;
            const indexes = urlIdentityIndex.get(key) || new Set();
            indexes.add(index);
            urlIdentityIndex.set(key, indexes);
          }
        }
      };
      draft.jobs.forEach(addJobIndex);
      for (const job of jobs) {
        let canonicalJobId = job.id;
        const externalKey = job.externalId === null || job.externalId === undefined || job.externalId === ""
          ? null
          : `${job.sourceId}\0${String(job.externalId)}`;
        const applyUrl = canonicalizeUrl(job.applyUrl);
        const urlIdentityKey = applyUrl && job.urlIdentity !== "source_fallback"
          ? `${applyUrl}\0${softJobIdentity(job)}`
          : null;
        const candidateIndexes = new Set([
          idIndex.get(job.id),
          ...(externalKey ? externalIndex.get(externalKey) || [] : []),
          ...(urlIdentityKey ? urlIdentityIndex.get(urlIdentityKey) || [] : []),
        ].filter((index) => Number.isInteger(index)));
        const index = [...candidateIndexes].find((candidateIndex) => {
          const item = draft.jobs[candidateIndex];
          return item.id === job.id && !sameSourceExternalIdConflict(item, job)
            || sourceIdentityViews(item).some((view) => jobsCanExactMerge(view, job));
        }) ?? -1;
        if (index >= 0) {
          const previous = draft.jobs[index];
          canonicalJobId = previous.id;
          observedIds.add(previous.id);
          const priorPrimaryHash = previous.sourceObservations?.[previous.sourceId]?.projection?.contentHash || previous.contentHash;
          const canonicalChanged = job.sourceId === previous.sourceId && priorPrimaryHash !== job.contentHash;
          const nextVersion = canonicalChanged ? Number(previous.version || 1) + 1 : Number(previous.version || 1);
          const sourceIds = [...new Set([...(previous.sourceIds || [previous.sourceId]), job.sourceId])];
          const sourceObservations = { ...(previous.sourceObservations || {}) };
          for (const id of sourceIds) {
            if (!sourceObservations[id]) sourceObservations[id] = {
              consecutiveMissing: 0,
              lastObservedAt: id === previous.sourceId ? previous.lastObservedAt || previous.observedAt || at : null,
              observedStatus: id === previous.sourceId ? previous.status || "confirmed_active" : "confirmed_active",
              validThrough: id === previous.sourceId ? previous.validThrough || null : null,
              activeScore: id === previous.sourceId ? Number(previous.activeScore || 0) : 0,
              projection: id === previous.sourceId ? sourceProjection(previous) : null,
            };
          }
          sourceObservations[job.sourceId] = {
            consecutiveMissing: 0,
            lastObservedAt: at,
            observedStatus: job.status || "confirmed_active",
            validThrough: job.validThrough || null,
            activeScore: Number(job.activeScore || 0),
            projection: sourceProjection(job),
          };
          const mergedStatus = supportedJobStatus(sourceIds, sourceObservations);
          const statusConflict = sourceIds.some((id) => sourceObservations[id]?.observedStatus === "closed")
            && sourceIds.some((id) => sourceObservations[id]?.observedStatus !== "closed");
          const merged = {
            ...previous,
            ...job,
            id: previous.id,
            sourceId: previous.sourceId,
            sourceIds,
            sourceObservations,
            evidence: [...(previous.evidence || []), ...(job.evidence || [])],
            status: mergedStatus,
            validThrough: statusConflict ? null : job.validThrough,
            activeScore: Math.max(...sourceIds.map((id) => Number(sourceObservations[id]?.activeScore || 0))),
            freshness: statusConflict ? "来源有效期冲突，需复核" : job.freshness,
            freshnessState: statusConflict ? "source_validity_conflict" : job.freshnessState,
            consecutiveMissing: 0,
            version: nextVersion,
            lastChangedAt: canonicalChanged ? at : previous.lastChangedAt,
            lastObservedAt: at,
            updatedAt: at,
          };
          applySupportedSourceProjection(draft, merged, merged.sourceId);
          merged.status = mergedStatus;
          merged.activeScore = Math.max(...sourceIds.map((id) => Number(sourceObservations[id]?.activeScore || 0)));
          if (statusConflict) {
            merged.validThrough = null;
            merged.freshness = "来源有效期冲突，需复核";
            merged.freshnessState = "source_validity_conflict";
          }
          draft.jobs[index] = merged;
          addJobIndex(merged, index);
          if (canonicalChanged) {
            draft.jobVersions.push({
              id: `version-${createHash("sha256").update(`${previous.id}\0${nextVersion}`).digest("hex").slice(0, 20)}`,
              jobId: previous.id,
              version: nextVersion,
              contentHash: job.contentHash,
              observedAt: at,
              data: { ...job, id: previous.id, sourceId: previous.sourceId },
            });
            updated += 1;
          }
          else unchanged += 1;
        } else {
          observedIds.add(job.id);
          const insertedJob = {
            ...job,
            sourceIds: [job.sourceId],
            sourceObservations: { [job.sourceId]: {
              consecutiveMissing: 0,
              lastObservedAt: at,
              observedStatus: job.status || "confirmed_active",
              validThrough: job.validThrough || null,
              activeScore: Number(job.activeScore || 0),
              projection: sourceProjection(job),
            } },
            version: 1,
            consecutiveMissing: 0,
            createdAt: at,
            lastChangedAt: at,
            lastObservedAt: at,
            updatedAt: at,
          };
          const insertedIndex = draft.jobs.push(insertedJob) - 1;
          addJobIndex(insertedJob, insertedIndex);
          draft.jobVersions.push({
            id: `version-${createHash("sha256").update(`${job.id}\0${1}`).digest("hex").slice(0, 20)}`,
            jobId: job.id,
            version: 1,
            contentHash: job.contentHash,
            observedAt: at,
            data: job,
          });
          inserted += 1;
        }
        upsertGraphEdge(draft, {
          from: sourceId,
          to: graphTarget("job", canonicalJobId),
          toType: "job",
          type: "lists_job",
          evidence: { kind: "collection_observation", runId, jobId: canonicalJobId, observedJobId: job.id, applyUrl: job.applyUrl, contentHash: job.contentHash },
          runId,
          verified: true,
        }, at);
        for (const region of job.workLocations || job.regions || []) {
          if (region?.countryCode !== "CN") continue;
          upsertGraphEdge(draft, {
            from: sourceId,
            to: graphTarget("region", `${region.provinceCode || "CN"}:${region.cityCode || "ALL"}`),
            toType: "region",
            type: "covers_region",
            evidence: { kind: "collected_job_region", runId, jobId: canonicalJobId, region },
            runId,
            verified: true,
          }, at);
        }
      }
      let missing = 0;
      for (const existing of draft.jobs.filter((item) => (
        (allowMissingAdvance || markMissingNeedsReview)
        && (item.sourceIds || [item.sourceId]).includes(sourceId)
        && !observedIds.has(item.id)
        && item.status !== "closed"
      ))) {
        const sourceIds = existing.sourceIds || [existing.sourceId];
        existing.sourceObservations = { ...(existing.sourceObservations || {}) };
        for (const id of sourceIds) {
          if (!existing.sourceObservations[id]) existing.sourceObservations[id] = {
            consecutiveMissing: 0,
            lastObservedAt: id === existing.sourceId ? existing.lastObservedAt || existing.observedAt || at : null,
            observedStatus: id === existing.sourceId ? existing.status || "confirmed_active" : "confirmed_active",
            validThrough: id === existing.sourceId ? existing.validThrough || null : null,
            activeScore: id === existing.sourceId ? Number(existing.activeScore || 0) : 0,
            projection: id === existing.sourceId ? sourceProjection(existing) : null,
          };
        }
        const currentObservation = existing.sourceObservations[sourceId];
        const effectiveThreshold = Math.max(2, Number(missingThreshold) || 2);
        if (allowMissingAdvance) {
          const previousMissing = currentObservation.missingMode === "review_only" ? 0 : Number(currentObservation.consecutiveMissing || 0);
          existing.sourceObservations[sourceId] = {
            ...currentObservation,
            consecutiveMissing: previousMissing + 1,
            closureThreshold: effectiveThreshold,
            missingMode: "authoritative",
            lastMissingAt: at,
          };
        } else {
          const freshnessLabel = "本次非权威来源采集未再发现该岗位，需复核";
          if (currentObservation.missingMode === "authoritative" && Number(currentObservation.consecutiveMissing || 0) > 0) {
            existing.sourceObservations[sourceId] = {
              ...currentObservation,
              lastNonAuthoritativeMissingAt: at,
            };
          } else {
            const activeScore = Math.min(Number(currentObservation.activeScore || 0), 50);
            const nextObservation = {
              ...currentObservation,
              consecutiveMissing: 1,
              missingMode: "review_only",
              lastMissingAt: at,
              activeScore,
              projection: currentObservation.projection && typeof currentObservation.projection === "object" ? {
                ...currentObservation.projection,
                freshness: freshnessLabel,
                freshnessState: "non_authoritative_absence",
                activeScore,
              } : currentObservation.projection,
            };
            delete nextObservation.closureThreshold;
            existing.sourceObservations[sourceId] = nextObservation;
          }
        }
        const missingCounts = sourceIds.map((id) => Number(existing.sourceObservations[id]?.consecutiveMissing || 0));
        existing.consecutiveMissing = Math.min(...missingCounts);
        existing.status = supportedJobStatus(sourceIds, existing.sourceObservations);
        existing.activeScore = existing.status === "closed" ? 0 : Math.max(...sourceIds.map((id) => Number(existing.sourceObservations[id]?.activeScore || 0)));
        if (markMissingNeedsReview && existing.status === "needs_review") {
          existing.freshness = "本次非权威来源采集未再发现该岗位，需复核";
          existing.freshnessState = "non_authoritative_absence";
        }
        existing.updatedAt = at;
        existing.evidence = [
          ...(existing.evidence || []),
          {
            kind: allowMissingAdvance ? "missing_from_successful_collection" : "missing_from_non_authoritative_collection",
            sourceId,
            observedAt: at,
            consecutiveMissing: existing.sourceObservations[sourceId].consecutiveMissing,
            runId,
          },
        ];
        missing += 1;
      }
      const softGroups = new Map();
      for (const existing of draft.jobs.filter((item) => item.status !== "closed")) {
        const key = softJobIdentity(existing);
        const group = softGroups.get(key) || [];
        group.push(existing.id);
        softGroups.set(key, group);
      }
      draft.duplicateCandidates = [...softGroups.entries()]
        .filter(([, jobIds]) => jobIds.length > 1)
        .map(([key, jobIds]) => ({
          id: `duplicate-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
          key,
          jobIds,
          action: "review_only_not_auto_merged",
          updatedAt: at,
        }));
      currentSource.revision += 1;
      currentSource.collection = {
        ...(currentSource.collection || {}),
        lastCollectedAt: at,
        runId,
        received: jobs.length,
        inserted,
        updated,
        unchanged,
        missing,
        missingAdvanceSuppressed: !allowMissingAdvance,
        missingReviewOnly: Boolean(markMissingNeedsReview),
      };
      draft.events.unshift({ id: stableEventId("jobs_collected", { sourceId, inserted, updated, unchanged, missing }, at), type: "jobs_collected", at, runId, sourceId, inserted, updated, unchanged, missing });
      return { sourceId, commit: true, received: jobs.length, new: inserted, updated, unchanged, missing, jobs };
    });
  }
}
