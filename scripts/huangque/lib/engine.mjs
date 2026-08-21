import { readFile, writeFile, mkdir, access, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { collectApprovedSource } from "./collector.mjs";
import { discoverSourceCandidates, deriveSourceIdentity, sourceOwnsJobUrl } from "./source-discovery.mjs";
import { FileArtifactStore } from "./artifacts.mjs";
import { probeCandidate } from "./probe.mjs";
import { runDiscoveryProviders } from "./providers.mjs";
import { JsonRegistry } from "./registry.mjs";
import { dueQueryBuckets, expandQueryPlan, queryTaskHasAvailableProvider, selectDueQueryTasks } from "./query-plan.mjs";
import { resolveHostedJob } from "./host-policy.mjs";
import { isLocalControlError } from "./http.mjs";
import { buildHostedProjection } from "./hosted-projection.mjs";
import { classifyChinaLocation, jobMatchesRegion, listChinaRegions } from "./china-regions.mjs";
import { analyzeSourceCoverage } from "./source-coverage.mjs";
import { loadEmployerUniverse } from "./employer-universe.mjs";
import {
  readSourceSpiderState,
  runSourceSpider as executeSourceSpider,
  sourceSpiderQueueSummary,
} from "./source-spider.mjs";
import { HUANGQUE_TOOLS } from "./agent-tools.mjs";

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取${label} ${path}：${error.message}`);
  }
}

export async function writeJsonAtomically(path, value, fileOperations = {}) {
  const makeDirectory = fileOperations.mkdir || mkdir;
  const write = fileOperations.writeFile || writeFile;
  const move = fileOperations.rename || rename;
  const remove = fileOperations.unlink || unlink;
  await makeDirectory(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await write(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await move(temporary, path);
  } catch (error) {
    await remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function graphSummary(state) {
  const byType = {};
  const nodeIds = new Set();
  let evidenced = 0;
  let verified = 0;
  for (const edge of state.edges || []) {
    byType[edge.type] = Number(byType[edge.type] || 0) + 1;
    nodeIds.add(`source:${edge.from}`);
    nodeIds.add(edge.to);
    if (edge.evidence && typeof edge.evidence === "object" && Object.keys(edge.evidence).length) evidenced += 1;
    if (edge.verificationState === "verified" || edge.lastVerifiedAt) verified += 1;
  }
  return {
    edges: state.edges.length,
    nodes: nodeIds.size,
    byType,
    evidenceCoverage: state.edges.length ? evidenced / state.edges.length : 0,
    verifiedCoverage: state.edges.length ? verified / state.edges.length : 0,
  };
}

function knownSnapshotFromRegistry(state) {
  return {
    sources: state.sources
      .filter((source) => source.lifecycle === "approved")
      .map((source) => ({
        id: source.id,
        name: source.name,
        provider: source.candidate?.provider || null,
        publicUrl: source.candidate?.sourceRootUrl,
      })),
  };
}

function providerErrors(providerRuns) {
  return providerRuns.flatMap((run) => run.warnings.map((warning) => ({ provider: run.provider, status: run.status, warning })));
}

export function discoveryExecutionStatus(providerRuns, { taskCount = 0 } = {}) {
  const runs = Array.isArray(providerRuns) ? providerRuns : [];
  const succeeded = runs.filter((run) => run?.status === "ok").length;
  const failed = runs.filter((run) => ["failed", "not_configured"].includes(run?.status)).length;
  if (failed > 0) return succeeded > 0 ? "partial" : "failed";
  if (succeeded > 0) return "completed";
  return taskCount > 0 ? "failed" : "no_work";
}

function collectionExecutionStatus(collection) {
  if (!collection) return null;
  const failed = Number(collection.stats?.sourcesFailed || 0);
  const succeeded = Number(collection.stats?.sourcesSucceeded || 0);
  if (failed > 0) return succeeded > 0 ? "partial" : "failed";
  if (Number(collection.stats?.sourcesIncomplete || 0) > 0) return "partial";
  return Number(collection.stats?.sourcesRequested || 0) > 0 ? "completed" : "no_work";
}

function positiveBoundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function collectionEvidenceSummary(result) {
  return {
    sourceId: result.sourceId,
    fetchedAt: result.fetchedAt,
    endpoint: result.endpoint,
    http: result.http,
    pagination: result.pagination,
    parser: result.parser,
    parserStats: result.parserStats,
    storage: result.storage,
    session: result.session,
  };
}

function availableQueryProviders(providers, baiduConfigured) {
  const requested = new Set(providers || []);
  const available = [];
  if (requested.has("baidu") && baiduConfigured) available.push("baidu");
  if (requested.has("common_crawl")) available.push("common_crawl");
  return available;
}

function discoveryBacklog(plan, bucketState, now, availableProviders) {
  const pending = selectDueQueryTasks(plan, bucketState, { now, maxQueries: Infinity });
  const runnable = pending.filter((task) => queryTaskHasAvailableProvider(task, availableProviders));
  const blocked = pending.filter((task) => !queryTaskHasAvailableProvider(task, availableProviders));
  return {
    pendingTasks: pending.length,
    runnableTasks: runnable.length,
    blockedTasks: blocked.length,
    blockedTaskIds: blocked.map((task) => task.id),
    blockedBuckets: [...new Set(blocked.map((task) => task.bucketId))],
    reason: blocked.length ? "baidu_not_configured_or_not_selected" : null,
  };
}

function snapshotExternalId(job) {
  const id = String(job?.id || "");
  for (const prefix of ["greenhouse-", "lever-", "ashby-", "beijing-gov-"]) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return job?.externalId || id || null;
}

export function completedDiscoveryTaskIds(tasks, providerRuns) {
  const completedTaskIds = new Set(providerRuns.flatMap((run) => run.metadata?.completedTaskIds || []));
  return tasks.map((task) => task.id).filter((taskId) => completedTaskIds.has(taskId));
}

export function collectionCadenceHours(source) {
  if (source?.candidate?.sourceType === "official_ats") return 6;
  if (/government|public/.test(String(source?.candidate?.sourceType || ""))) return 12;
  return 24;
}

export function collectionDueState(source, now = new Date()) {
  const current = new Date(now);
  const explicit = source?.collection?.nextDueAt ? new Date(source.collection.nextDueAt) : null;
  if (explicit && !Number.isNaN(explicit.getTime())) {
    return { due: explicit <= current, dueAt: explicit.toISOString(), cadenceHours: collectionCadenceHours(source) };
  }
  const last = source?.collection?.lastAttemptedAt || source?.collection?.lastCollectedAt;
  const parsed = last ? new Date(last) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return { due: true, dueAt: null, cadenceHours: collectionCadenceHours(source) };
  const dueAt = new Date(parsed.getTime() + collectionCadenceHours(source) * 3_600_000);
  return { due: dueAt <= current, dueAt: dueAt.toISOString(), cadenceHours: collectionCadenceHours(source) };
}

function readyProbeBacklog(state, now = new Date()) {
  const current = new Date(now);
  return state.sources
    .filter((source) => {
      if (source.lifecycle === "candidate" && source.reviewStatus === "unreviewed" && source.verificationState === "unverified_candidate") return true;
      if (source.lifecycle !== "probed" || source.verificationState !== "probe_failed" || source.collectionEnabled) return false;
      const lastProbedAt = source.lastProbedAt ? new Date(source.lastProbedAt) : null;
      return lastProbedAt && !Number.isNaN(lastProbedAt.getTime()) && current.getTime() - lastProbedAt.getTime() >= 24 * 3_600_000;
    })
    .filter((source) => source.collectionEnabled === false && source.candidate?.status === "ready_for_probe")
    .sort((left, right) => {
      const leftQueuedAt = String(left.lastProbedAt || left.discoveredAt || left.lastDiscoveredAt || "");
      const rightQueuedAt = String(right.lastProbedAt || right.discoveredAt || right.lastDiscoveredAt || "");
      return leftQueuedAt.localeCompare(rightQueuedAt)
        || Number(right.candidate?.discoveryPriorityScore || 0) - Number(left.candidate?.discoveryPriorityScore || 0)
        || left.id.localeCompare(right.id);
    });
}

export function jobWithEffectiveValidity(job, now = new Date()) {
  const validThrough = job?.validThrough ? new Date(job.validThrough) : null;
  if (!validThrough || Number.isNaN(validThrough.getTime()) || validThrough >= new Date(now) || ["closed", "quarantined"].includes(job.status)) return job;
  return {
    ...job,
    status: "closed",
    activeScore: 0,
    freshness: "有效期已结束",
    freshnessState: "expired",
  };
}

export function schedulerObservationIsLive(observation, env = process.env) {
  return env?.GITHUB_ACTIONS === "true"
    && Boolean(env?.GITHUB_RUN_ID)
    && observation?.trigger === "github_actions"
    && observation?.stage === "post_pipeline_finalization"
    && ["completed", "completed_with_findings", "no_work"].includes(observation?.status)
    && String(observation?.runId || "") === String(env.GITHUB_RUN_ID);
}

function receiptIsRecent(receipt, now, maximumHours, successfulStatuses) {
  const at = new Date(receipt?.completedAt || receipt?.generatedAt || 0);
  const age = new Date(now).getTime() - at.getTime();
  return successfulStatuses.includes(receipt?.status)
    && !Number.isNaN(at.getTime())
    && age >= -5 * 60_000
    && age <= maximumHours * 3_600_000;
}

function recoveryReceiptVerified(receipt) {
  const verification = receipt?.verification;
  const required = [
    "registryBundleVerified", "completeInventoryMatched", "employerUniverseValid",
    "sourceSpiderStateValid", "optionalLatestReceiptsValid", "statusMatchedRegistry",
    "sourcePlaintextRegistryAbsent", "transientStateFilesAbsent",
  ];
  return receipt?.schemaVersion === "huangque.state-recovery.v2"
    && receipt?.trigger === "github_actions"
    && receipt?.status === "completed"
    && required.every((key) => verification?.[key] === true)
    && receipt?.stateInventory?.matched === true
    && receipt?.stateInventory?.source?.sha256 === receipt?.stateInventory?.restored?.sha256
    && /^[a-f0-9]{64}$/.test(String(receipt?.registryBundle?.compressed?.sha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(receipt?.registryBundle?.restoredRegistry?.sha256 || ""))
    && receipt?.registryBundle?.restoredRegistry?.persistedInSourceBranch === false
    && receipt?.employerUniverse?.complete === true
    && Number(receipt?.employerUniverse?.targets || 0) >= 5_000
    && receipt?.sourceSpiderState?.schemaVersion === "huangque.source-spider-state.v1"
    && /^[a-f0-9]{40}$/.test(String(receipt?.github?.stateCommitSha || ""));
}

function observationIsRecent(value, now, maximumHours) {
  const at = new Date(value || 0);
  const age = new Date(now).getTime() - at.getTime();
  return !Number.isNaN(at.getTime()) && age >= -5 * 60_000 && age <= maximumHours * 3_600_000;
}

async function successfulReceiptDates(path, successfulStatuses, predicate = () => true) {
  const names = await readdir(path).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const receipts = await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(resolve(path, name), "调度收据").catch(() => null)));
  return [...new Set(receipts
    .filter((receipt) => receipt?.trigger === "github_actions"
      && receipt?.timezone === "Asia/Shanghai"
      && /^\d{4}-\d{2}-\d{2}$/.test(String(receipt?.scheduledDate || ""))
      && successfulStatuses.includes(receipt?.status)
      && predicate(receipt))
    .map((receipt) => receipt.scheduledDate)
    .filter(Boolean))].sort();
}

export class HuangqueEngine {
  constructor({
    projectRoot,
    registryPath = resolve(projectRoot, ".huangque/state.json"),
    artifactRoot = resolve(projectRoot, ".huangque/artifacts"),
    queryPlanPath = resolve(projectRoot, "data/huangque/national-query-plan.json"),
    sourceChannelPlanPath = resolve(projectRoot, "data/huangque/source-channel-plan.json"),
    employerUniversePath = resolve(projectRoot, "data/huangque/employer-universe.json"),
    sourceSpiderStatePath = null,
    catalogPath = resolve(projectRoot, "data/huangque/public-source-catalog.json"),
    existingSnapshotPath = resolve(projectRoot, "app/data/job-data.json"),
    verifiedSourceSeedsPath = resolve(projectRoot, "data/huangque/verified-source-seeds.json"),
    now = () => new Date(),
    fetchOptions = {},
    providerOptions = {},
  }) {
    if (!projectRoot) throw new TypeError("HuangqueEngine 需要 projectRoot");
    this.projectRoot = projectRoot;
    this.registryPath = registryPath;
    this.runtimeRoot = dirname(registryPath);
    this.queryPlanPath = queryPlanPath;
    this.sourceChannelPlanPath = sourceChannelPlanPath;
    this.employerUniversePath = employerUniversePath;
    this.sourceSpiderStatePath = sourceSpiderStatePath || resolve(this.runtimeRoot, "source-spider-state.json");
    this.catalogPath = catalogPath;
    this.existingSnapshotPath = existingSnapshotPath;
    this.verifiedSourceSeedsPath = verifiedSourceSeedsPath;
    this.now = now;
    this.fetchOptions = fetchOptions;
    this.providerOptions = providerOptions;
    this.registry = new JsonRegistry(registryPath, { now });
    this.artifactStore = new FileArtifactStore(artifactRoot);
  }

  async status() {
    const [state, plan, universe, spiderState] = await Promise.all([
      this.registry.snapshot(),
      readJson(this.queryPlanPath, "查询计划"),
      loadEmployerUniverse(this.employerUniversePath),
      readSourceSpiderState(this.sourceSpiderStatePath, this.now()),
    ]);
    const sourceCounts = Object.fromEntries(["candidate", "probed", "approved", "rejected"].map((lifecycle) => [lifecycle, state.sources.filter((source) => source.lifecycle === lifecycle).length]));
    const regionCounts = {};
    for (const job of state.jobs) for (const region of job.workLocations || job.regions || []) regionCounts[region.label] = Number(regionCounts[region.label] || 0) + 1;
    const providerRuns = [
      ...Object.values(state.providerObservations || {}),
      ...state.runs.flatMap((run) => run.providerRuns || []),
    ];
    const baiduConfigured = Boolean(this.providerOptions.baidu?.apiKey || process.env.HUANGQUE_BAIDU_API_KEY);
    const backlog = discoveryBacklog(plan, state.bucketState, this.now(), availableQueryProviders(["baidu", "common_crawl"], baiduConfigured));
    return {
      schemaVersion: "huangque.status.v1",
      project: "黄雀",
      definition: "岗位垂类的信息源归集引擎",
      registryRevision: state.revision,
      sourceCounts,
      scope: "全国（省/直辖市—地级市二级分类）",
      regionDataVersion: "2025-12-31",
      graph: graphSummary(state),
      graphEdges: state.edges.length,
      jobs: state.jobs.length,
      regionCounts,
      runs: state.runs.length,
      dueBuckets: dueQueryBuckets(plan, state.bucketState, this.now()).filter((bucket) => bucket.due).map((bucket) => bucket.id),
      discoveryBacklog: backlog,
      employerUniverse: {
        targets: universe.targets.length,
        generatedAt: universe.generatedAt || universe.metadata?.generatedAt || null,
        complete: universe.targets.length >= 5_000
          && universe.metadata?.completeness === "bounded_official_directory_universe",
        queue: sourceSpiderQueueSummary(universe, state, spiderState, this.now()),
      },
      providerConfiguration: {
        baidu: baiduConfigured ? "configured" : "not_configured",
        commonCrawl: "keyless",
        officialCatalog: "configured",
      },
      providerEvidence: {
        baidu: providerRuns.some((run) => run.provider === "baidu" && run.status === "ok" && Number(run.metadata?.requestCount || 0) > 0),
        commonCrawl: providerRuns.some((run) => run.provider === "common_crawl" && run.status === "ok" && Boolean(run.metadata?.indexId)),
        officialCatalog: providerRuns.some((run) => run.provider === "official_catalog" && run.status === "ok" && Number(run.hits || 0) > 0),
        userSubmission: state.runs.some((run) => run.kind === "submission" && run.status === "completed"),
      },
      providerBudgets: state.providerBudgets || {},
      boundaries: {
        excluded: ["微信群", "私域图片", "邮件", "需登录或验证码的封闭渠道"],
        approvalRequiredBeforeCollection: true,
      },
    };
  }

  async sourceCoverage() {
    const [coverage, universe, state, spiderState] = await Promise.all([
      analyzeSourceCoverage({
        projectRoot: this.projectRoot,
        registry: this.registry,
        queryPlanPath: this.queryPlanPath,
        channelPlanPath: this.sourceChannelPlanPath,
      }),
      loadEmployerUniverse(this.employerUniversePath),
      this.registry.snapshot(),
      readSourceSpiderState(this.sourceSpiderStatePath, this.now()),
    ]);
    const employerQueue = sourceSpiderQueueSummary(universe, state, spiderState, this.now());
    return {
      ...coverage,
      schemaVersion: "huangque.source-coverage.v2",
      summary: {
        ...coverage.summary,
        employerUniverseTargets: universe.targets.length,
        employerUniverseApproved: employerQueue.approved,
        employerUniverseVerifiedPendingReview: employerQueue.verifiedPendingReview,
        employerUniverseDiscovered: employerQueue.discovered,
        employerUniverseMissing: employerQueue.missing,
      },
      employerUniverse: {
        schemaVersion: universe.schemaVersion,
        generatedAt: universe.metadata?.generatedAt || null,
        definition: universe.metadata?.definition || null,
        completeness: universe.metadata?.completeness || null,
        stats: universe.stats,
        queue: employerQueue,
        note: "完整目标清单保存在 employer-universe.json；此响应只返回统计，避免把 5000+ 条记录塞进一次 Agent 调用。",
      },
      priorityTargets: coverage.targets,
      limitations: [
        ...coverage.limitations,
        "5000+ 目标库是交易所、央企名录与版本化优先目标组成的有界寻源分母，不代表中国全部用人单位。",
      ],
    };
  }

  async bootstrapExistingSources({ verifiedSeedsOnly = false } = {}) {
    const bootstrapPath = verifiedSeedsOnly
      ? await pathExists(this.verifiedSourceSeedsPath) ? this.verifiedSourceSeedsPath : null
      : await pathExists(this.existingSnapshotPath)
      ? this.existingSnapshotPath
      : await pathExists(this.verifiedSourceSeedsPath) ? this.verifiedSourceSeedsPath : null;
    if (!bootstrapPath) {
      await this.registry.snapshot();
      return { imported: 0, sources: [], note: "已创建空 Registry；未提供可选的历史岗位快照。" };
    }
    const verifiedSeedBootstrap = bootstrapPath === this.verifiedSourceSeedsPath;
    const snapshot = await readJson(bootstrapPath, verifiedSeedBootstrap ? "已核验来源种子" : "现有岗位快照");
    const imported = [];
    const snapshotSourceRecords = new Map();
    for (const source of snapshot.sources || []) {
      const identity = deriveSourceIdentity(source.publicUrl);
      if (!identity || source.fetchStatus !== "ok") continue;
      const observedRegions = [...new Map((snapshot.jobs || [])
        .filter((job) => job.sourceId === source.id)
        .flatMap((job) => job.workLocations || job.regions || [])
        .filter((region) => region?.countryCode === "CN")
        .map((region) => [`${region.provinceCode || "CN"}:${region.cityCode || "ALL"}:${region.remote ? "R" : "O"}`, {
          ...region,
          confidence: 1,
          basis: "existing_snapshot_job_coverage",
        }])).values()];
      const sourceRegions = identity.provider === "BeijingPublicEmployment"
        ? classifyChinaLocation("北京", { confidence: 1, basis: "authoritative_source_scope" }).regions
        : observedRegions;
      const candidate = {
        schemaVersion: "huangque.candidate-source.v1",
        id: source.id,
        name: source.name,
        publisher: identity.systemType === "ats" ? source.name.replace(/\s*官方招聘$/, "") : source.provider,
        publisherKey: `host:${new URL(identity.sourceRootUrl).hostname}`,
        sourceKey: identity.sourceKey,
        entryUrl: identity.canonicalUrl,
        sourceRootUrl: identity.sourceRootUrl,
        provider: identity.provider || source.provider,
        tenant: identity.tenant,
        publicApiUrl: identity.publicApiUrl,
        sourceType: source.kind || (identity.systemType === "ats" ? "official_ats" : "government_public_employment"),
        endpointType: identity.publicApiUrl ? "api_feed" : "job_list",
        authority: identity.systemType === "ats" ? "employer_controlled_board" : "official_government",
        collectionStrategy: identity.publicApiUrl ? "public_api" : "listing_html",
        discoveryPriorityScore: 100,
        verificationState: "verified",
        status: "already_registered",
        decision: {
          status: "already_registered",
          reasonCodes: [verifiedSeedBootstrap ? "VERIFIED_SOURCE_SEED" : "EXISTING_SNAPSHOT_SOURCE"],
          decidedBy: verifiedSeedBootstrap ? "reviewed_seed_manifest" : "bootstrap_existing_snapshot",
        },
        registryMatch: { status: "known", sourceId: source.id, matchedBy: verifiedSeedBootstrap ? "verified_source_seed" : "existing_snapshot" },
        scopeSignals: sourceRegions.map((region) => region.label),
        regions: sourceRegions,
        queryIds: [verifiedSeedBootstrap ? "verified-source-seed" : "existing-snapshot"],
        discoveredUrls: [identity.canonicalUrl],
        titles: [source.name],
        latestPublishedAt: source.latest,
        signals: [{
          code: verifiedSeedBootstrap ? "verified_source_seed" : "existing_snapshot",
          label: verifiedSeedBootstrap ? "公开发布包中经审核的来源种子" : "现有岗位快照已注册来源",
          weight: 100,
          evidence: source.publicUrl,
        }],
        evidence: [{
          channel: verifiedSeedBootstrap ? "verified_source_seed" : "existing_snapshot",
          url: source.publicUrl,
          observedAt: source.fetchedAt,
          jobs: source.jobs,
          manifestSchemaVersion: verifiedSeedBootstrap ? snapshot.metadata?.schemaVersion || null : null,
        }],
        nextAction: "按批准来源定期重新采集和健康检查",
      };
      const record = await this.registry.importApprovedSource(candidate, {
        probe: {
          schemaVersion: "huangque.probe.v1",
          sourceId: source.id,
          probedAt: source.fetchedAt,
          verificationState: "verified",
          collectable: true,
          strategy: verifiedSeedBootstrap ? "reviewed_seed_manifest" : "existing_snapshot_evidence",
          evidence: [{
            kind: verifiedSeedBootstrap ? "verified_source_seed" : "existing_snapshot",
            fetchedAt: source.fetchedAt,
            jobs: source.jobs,
            fetchStatus: source.fetchStatus,
            note: source.note || null,
          }],
          errors: [],
          edges: identity.publicApiUrl ? [{ type: "collection_endpoint", to: identity.publicApiUrl }] : [],
          sampleJobs: [],
          counts: { total: source.jobs, china: source.jobs, beijing: identity.provider === "BeijingPublicEmployment" ? source.jobs : 0 },
        },
      });
      imported.push(record);
      snapshotSourceRecords.set(source.id, record);
    }
    const skippedJobs = [];
    const snapshotJobs = [];
    for (const job of snapshot.jobs || []) {
      const source = snapshotSourceRecords.get(job.sourceId);
      const regions = job.workLocations || job.regions || [];
      const reasons = [];
      if (!source) reasons.push("SOURCE_NOT_IMPORTED");
      if (job.schemaVersion !== "huangque.job.v2") reasons.push("JOB_SCHEMA_NOT_V2");
      if (!Array.isArray(regions) || !regions.some((region) => region?.countryCode === "CN")) reasons.push("NO_STRUCTURED_CHINA_LOCATION");
      if (source && !sourceOwnsJobUrl(source, job.sourceUrl)) reasons.push("SOURCE_URL_OUTSIDE_APPROVED_BOUNDARY");
      if (source && !sourceOwnsJobUrl(source, job.applyUrl)) reasons.push("APPLY_URL_OUTSIDE_APPROVED_BOUNDARY");
      if (reasons.length) {
        skippedJobs.push({ jobId: job.id || null, originalSourceId: job.sourceId || null, reasons });
        continue;
      }
        const observedAt = job.observedAt || snapshot.metadata?.generatedAt || new Date(this.now()).toISOString();
        const evidence = (job.evidence || []).map((item) => typeof item === "object" && item !== null
          ? item
          : { kind: "source_statement", detail: String(item), observedAt });
        const contentHash = job.contentHash || createHash("sha256").update(JSON.stringify({
          title: job.title,
          company: job.company,
          location: job.location,
          workLocations: job.workLocations || job.regions,
          department: job.department,
          employmentType: job.employmentType,
          workplaceType: job.workplaceType,
          salary: job.salary,
          publishedAt: job.publishedAt,
          validThrough: job.validThrough || null,
          applyUrl: job.applyUrl,
          description: job.description,
        })).digest("hex");
        snapshotJobs.push({
          ...job,
          schemaVersion: "huangque.job.v2",
          sourceId: source.id,
          sourceKey: source.sourceKey,
          externalId: snapshotExternalId(job),
          urlIdentity: job.urlIdentity || "job_detail",
          parser: job.parser || "existing_snapshot_bootstrap",
          validThrough: job.validThrough || null,
          freshnessState: job.freshnessState || "source_listed",
          contentHash,
          evidence: [
            { kind: "existing_snapshot_job", originalSourceId: job.sourceId, sourceId: source.id, sourceUrl: job.sourceUrl, applyUrl: job.applyUrl, observedAt, snapshotGeneratedAt: snapshot.metadata?.generatedAt || null, contentHash },
            ...evidence,
          ],
        });
    }
    let jobImport = { received: 0, new: 0, updated: 0, unchanged: 0, skipped: skippedJobs.length, skippedJobs, sourceRuns: 0, runId: null };
    if (snapshotJobs.length) {
      const run = await this.registry.createRun("snapshot_bootstrap", {
        snapshotSchemaVersion: snapshot.metadata?.schemaVersion || snapshot.schemaVersion || null,
        snapshotGeneratedAt: snapshot.metadata?.generatedAt || null,
      });
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let sourceRuns = 0;
      const groups = Map.groupBy(snapshotJobs, (job) => job.sourceId);
      try {
        for (const [sourceId, jobs] of groups) {
          const storage = await this.registry.storeJobs(sourceId, jobs, {
            commit: true,
            runId: run.id,
            allowMissingAdvance: false,
          });
          inserted += storage.new;
          updated += storage.updated;
          unchanged += storage.unchanged;
          sourceRuns += 1;
        }
        jobImport = { received: snapshotJobs.length, new: inserted, updated, unchanged, skipped: skippedJobs.length, skippedJobs, sourceRuns, runId: run.id };
        await this.registry.finishRun(run.id, {
          status: "completed",
          stats: jobImport,
          output: { sourceIds: [...groups.keys()], jobIds: snapshotJobs.map((job) => job.id) },
        });
      } catch (error) {
        await this.registry.finishRun(run.id, { status: "failed", errors: [{ code: error.code || "SNAPSHOT_BOOTSTRAP_FAILED", message: error.message }] });
        throw error;
      }
    }
    return {
      imported: imported.length,
      sources: imported,
      jobs: jobImport,
      bootstrapMode: verifiedSeedBootstrap ? "verified_source_seeds" : "existing_snapshot",
    };
  }

  async discoverSources({
    providers = ["official_catalog", "common_crawl", "baidu"],
    bucketIds = null,
    maxQueries = 40,
    importedInput = null,
    force = false,
    provinceCode = null,
    cityCode = null,
  } = {}) {
    const run = await this.registry.createRun("discovery", { providers, bucketIds, maxQueries, force, provinceCode, cityCode });
    try {
      const [state, plan] = await Promise.all([this.registry.snapshot(), readJson(this.queryPlanPath, "查询计划")]);
      const effectiveProviders = importedInput && !providers.includes("imported") ? [...providers, "imported"] : providers;
      const baiduConfigured = Boolean(this.providerOptions.baidu?.apiKey || process.env.HUANGQUE_BAIDU_API_KEY);
      const availableProviders = availableQueryProviders(effectiveProviders, baiduConfigured);
      const selectionLimit = provinceCode || cityCode ? Infinity : maxQueries;
      let tasks = force
        ? selectDueQueryTasks(plan, state.bucketState, { now: this.now(), bucketIds: bucketIds || plan.buckets.map((bucket) => bucket.id), maxQueries: selectionLimit, availableProviders })
        : selectDueQueryTasks(plan, state.bucketState, { now: this.now(), bucketIds, maxQueries: selectionLimit, availableProviders });
      let blockedTasks = selectDueQueryTasks(plan, state.bucketState, {
        now: this.now(),
        bucketIds: force ? bucketIds || plan.buckets.map((bucket) => bucket.id) : bucketIds,
        maxQueries: Infinity,
      }).filter((task) => !queryTaskHasAvailableProvider(task, availableProviders));
      if (provinceCode || cityCode) {
        const province = listChinaRegions({ provinceCode })[0];
        const city = province?.cities.find((item) => item.cityCode === cityCode);
        if (!province || cityCode && !city) throw Object.assign(new Error("省市代码组合无效"), { code: "INVALID_REGION" });
        const regionTaskMatches = (task) => {
          if (!task.dimensions?.province && !task.dimensions?.city) return true;
          if (task.dimensions.province) return [province.label, province.provinceName].includes(task.dimensions.province);
          return !cityCode || [city.cityName, city.cityName.replace(/市$/, "")].includes(task.dimensions.city);
        };
        tasks = tasks.filter(regionTaskMatches).slice(0, maxQueries);
        blockedTasks = blockedTasks.filter(regionTaskMatches);
      }
      const baiduDailyLimit = positiveBoundedInteger(process.env.HUANGQUE_BAIDU_DAILY_BUDGET, 40, 10_000);
      const input = await runDiscoveryProviders(tasks, {
        providers: effectiveProviders,
        catalogPath: this.catalogPath,
        channelPlanPath: this.sourceChannelPlanPath,
        importedInput,
        now: this.now(),
        baidu: {
          ...this.providerOptions.baidu,
          maxQueries: Math.min(baiduDailyLimit, positiveBoundedInteger(this.providerOptions.baidu?.maxQueries, baiduDailyLimit, baiduDailyLimit)),
          reserveRequest: () => this.registry.reserveDailyProviderRequest("baidu", { limit: baiduDailyLimit, now: this.now() }),
          fetchOptions: { ...this.fetchOptions, requestPhase: "discovery" },
        },
        commonCrawl: { ...this.providerOptions.commonCrawl, fetchOptions: { ...this.fetchOptions, requestPhase: "discovery" } },
      });
      if (input.queries.length === 0) input.queries = [{ id: "empty-provider-output", query: "", channel: "none", results: [] }];
      const discovery = discoverSourceCandidates(input, { knownSnapshot: knownSnapshotFromRegistry(state), observedAt: input.metadata.observedAt });
      await this.registry.upsertCandidates(discovery, run.id);
      const completedTaskIds = completedDiscoveryTaskIds(tasks, input.metadata.providerRuns);
      const progress = completedTaskIds.length
        ? await this.registry.updateDiscoveryProgress(completedTaskIds, expandQueryPlan(plan), run.id)
        : { completedBucketIds: [], progress: {} };
      const stats = {
        ...discovery.stats,
        queriesSelected: tasks.length,
        queriesCompleted: completedTaskIds.length,
        bucketsCompleted: progress.completedBucketIds.length,
        bucketProgress: progress.progress,
        queriesBlocked: blockedTasks.length,
        blockedTaskIds: blockedTasks.map((task) => task.id),
        blockedReason: blockedTasks.length ? "baidu_not_configured_or_not_selected" : null,
      };
      const status = discoveryExecutionStatus(input.metadata.providerRuns, { taskCount: tasks.length });
      await this.registry.finishRun(run.id, {
        status,
        stats,
        providerRuns: input.metadata.providerRuns,
        errors: providerErrors(input.metadata.providerRuns),
        output: { sourceIds: discovery.candidates.map((candidate) => candidate.id), blockedTaskIds: stats.blockedTaskIds },
      });
      return { runId: run.id, status, tasks, blockedTasks, input, discovery, stats };
    } catch (error) {
      await this.registry.finishRun(run.id, { status: "failed", errors: [{ code: error.code || "DISCOVERY_FAILED", message: error.message }] });
      throw error;
    }
  }

  async submitSource({ url, title = "用户提交的招聘来源", note = "", observedAt = this.now() }) {
    const importedInput = {
      schemaVersion: "huangque.discovery-input.v1",
      metadata: { scope: "全国", provider: "user_submission", observedAt: new Date(observedAt).toISOString() },
      queries: [{ id: "user-submission", query: "中国 招聘 来源", channel: "user_submission", results: [{ title, snippet: `${note} 中国 招聘 岗位`, url, providerEvidence: { kind: "user_submission", submittedAt: new Date(observedAt).toISOString() } }] }],
    };
    const state = await this.registry.snapshot();
    const discovery = discoverSourceCandidates(importedInput, { knownSnapshot: knownSnapshotFromRegistry(state) });
    if (!discovery.candidates.length) throw Object.assign(new Error("提交的 URL 无法形成安全候选来源"), { code: "INVALID_SOURCE_URL" });
    const run = await this.registry.createRun("submission", { url, title });
    await this.registry.upsertCandidates(discovery, run.id);
    await this.registry.finishRun(run.id, { stats: discovery.stats, output: { sourceIds: discovery.candidates.map((candidate) => candidate.id) } });
    return { runId: run.id, discovery };
  }

  async probeSource({ sourceId, url = null }) {
    let effectiveSourceId = sourceId;
    if (!effectiveSourceId && url) {
      const submitted = await this.submitSource({ url });
      effectiveSourceId = submitted.discovery.candidates[0].id;
    }
    const run = await this.registry.createRun("probe", { sourceId: effectiveSourceId });
    try {
      const state = await this.registry.snapshot();
      const source = state.sources.find((item) => item.id === effectiveSourceId);
      if (!source) throw Object.assign(new Error(`来源不存在：${effectiveSourceId}`), { code: "SOURCE_NOT_FOUND" });
      const probe = await probeCandidate(source.candidate, { now: this.now(), fetchOptions: { ...this.fetchOptions, requestPhase: "probe" } });
      await this.registry.recordProbe(source.id, probe, run.id);
      let clueDiscovery = null;
      if (probe.sourceClues?.length) {
        const directoryParent = source.candidate?.sourceType === "official_source_directory";
        const clueInput = {
          schemaVersion: "huangque.discovery-input.v1",
          metadata: { project: "黄雀", scope: "全国", provider: "source_spider", observedAt: probe.probedAt },
          queries: [{
            id: `source-spider:${source.id}`,
            query: `${source.name || source.id} 中国 招聘来源外链`,
            channel: "source_spider",
            results: probe.sourceClues.map((clue, index) => {
              let governmentTarget = false;
              try { governmentTarget = new URL(clue.url).hostname === "gov.cn" || new URL(clue.url).hostname.endsWith(".gov.cn"); }
              catch { governmentTarget = false; }
              return {
                title: clue.title || `来源外链 ${index + 1}`,
                snippet: `${source.name || source.id} 的公开招聘页面链接；仅作为新候选，必须另行探测和审核。`,
                url: clue.url,
                rank: index + 1,
                providerEvidence: {
                  kind: clue.evidenceKind,
                  parentSourceId: source.id,
                  parentUrl: clue.parentUrl,
                  authority: directoryParent && governmentTarget ? "official_government_directory_link" : null,
                },
              };
            }),
          }],
        };
        clueDiscovery = discoverSourceCandidates(clueInput, { knownSnapshot: knownSnapshotFromRegistry(state), observedAt: probe.probedAt });
        await this.registry.upsertCandidates(clueDiscovery, run.id);
      }
      const discoveredSourceIds = clueDiscovery?.candidates.map((candidate) => candidate.id) || [];
      await this.registry.finishRun(run.id, {
        status: probe.verificationState === "verified" ? "completed" : "completed_with_findings",
        stats: { verified: probe.verificationState === "verified" ? 1 : 0, sourceClues: probe.sourceClues?.length || 0, sourcesDiscovered: discoveredSourceIds.length },
        errors: probe.errors,
        output: { sourceIds: [source.id, ...discoveredSourceIds] },
      });
      return { runId: run.id, sourceId: source.id, probe, discoveredSourceIds };
    } catch (error) {
      await this.registry.finishRun(run.id, { status: "failed", errors: [{ code: error.code || "PROBE_FAILED", message: error.message }] });
      throw error;
    }
  }

  async reviewSource(arguments_) {
    return this.registry.reviewSource(arguments_.sourceId, arguments_);
  }

  async collectJobs({ sourceId = null, commit = false } = {}) {
    const state = await this.registry.snapshot();
    const sourceIds = sourceId
      ? [sourceId]
      : state.sources.filter((source) => source.lifecycle === "approved" && source.collectionEnabled).map((source) => source.id);
    const run = await this.registry.createRun("collection", { sourceIds, commit });
    const results = [];
    const errors = [];
    const failedArtifacts = [];
    for (const id of sourceIds) {
      const source = state.sources.find((item) => item.id === id);
      try {
        const result = await collectApprovedSource(this.registry, id, {
          commit,
          runId: run.id,
          now: this.now(),
          fetchOptions: { ...this.fetchOptions, requestPhase: "collection" },
          artifactStore: this.artifactStore,
        });
        if (commit) {
          await this.registry.recordCollectionAttempt(id, {
            runId: run.id,
            success: true,
            commit,
            cadenceHours: collectionCadenceHours(source),
          });
        }
        results.push(result);
      } catch (error) {
        failedArtifacts.push(...(error.artifacts || []).map((artifact) => ({ sourceId: id, ...artifact })));
        if (commit && !isLocalControlError(error) && !["SOURCE_NOT_APPROVED", "SOURCE_NOT_FOUND"].includes(error.code)) {
          await this.registry.recordCollectionAttempt(id, {
            runId: run.id,
            success: false,
            commit,
            cadenceHours: collectionCadenceHours(source),
            error: { code: error.code || "COLLECTION_FAILED", message: error.message },
          }).catch(() => undefined);
        }
        errors.push({ sourceId: id, code: error.code || "COLLECTION_FAILED", message: error.message, robots: error.robots || null });
        if (isLocalControlError(error)) break;
      }
    }
    const stats = {
      sourcesRequested: sourceIds.length,
      sourcesSucceeded: results.length,
      sourcesFailed: errors.length,
      sourcesIncomplete: results.filter((result) => result.pagination?.complete === false).length,
      jobsObserved: results.reduce((sum, item) => sum + item.storage.received, 0),
      jobsNew: results.reduce((sum, item) => sum + item.storage.new, 0),
      jobsUpdated: results.reduce((sum, item) => sum + item.storage.updated, 0),
    };
    const artifacts = [...results.flatMap((result) => result.artifacts.map((artifact) => ({
      sourceId: result.sourceId,
      observationId: artifact.observationId,
      contentHash: artifact.contentHash,
    }))), ...failedArtifacts];
    const collectionEvidence = results.map(collectionEvidenceSummary);
    await this.registry.finishRun(run.id, { status: errors.length ? "completed_with_errors" : stats.sourcesIncomplete ? "completed_with_findings" : "completed", stats, errors, output: { sourceIds, artifacts, collectionEvidence } });
    const localControlFailure = errors.find((error) => isLocalControlError(error));
    if (localControlFailure) {
      throw Object.assign(new Error(localControlFailure.message), { code: localControlFailure.code, runId: run.id, sourceId: localControlFailure.sourceId });
    }
    if (sourceId && results.length === 0 && errors.length === 1) {
      throw Object.assign(new Error(errors[0].message), { code: errors[0].code, runId: run.id, sourceId, robots: errors[0].robots || null });
    }
    return { runId: run.id, commit, stats, errors, results };
  }

  async runPipeline({
    providers,
    bucketIds,
    maxQueries = 20,
    maxProbes = 10,
    collectApproved = false,
    commit = false,
    force = false,
    provinceCode = null,
    cityCode = null,
  } = {}) {
    const discovery = await this.discoverSources({ providers, bucketIds, maxQueries, force, provinceCode, cityCode });
    const probeState = await this.registry.snapshot();
    const probeBacklog = readyProbeBacklog(probeState, this.now());
    const probeLimit = Math.max(0, Math.floor(Number(maxProbes) || 0));
    const probeCandidates = probeBacklog.slice(0, probeLimit);
    const probes = [];
    for (const source of probeCandidates) probes.push(await this.probeSource({ sourceId: source.id }));
    const collection = collectApproved ? await this.collectJobs({ commit }) : null;
    const collectionStatus = collectionExecutionStatus(collection);
    const status = discovery.status === "failed" || collectionStatus === "failed" ? "failed"
      : discovery.status === "partial" || collectionStatus === "partial" ? "partial"
        : discovery.status === "no_work" && probes.length === 0 && (!collection || collectionStatus === "no_work") ? "no_work"
          : probes.some((item) => item.probe.verificationState !== "verified") ? "completed_with_findings" : "completed";
    return {
      schemaVersion: "huangque.pipeline.v1",
      status,
      discoveryStatus: discovery.status,
      collectionStatus,
      discoveryRunId: discovery.runId,
      discovered: discovery.discovery.stats,
      providerRuns: discovery.input?.metadata?.providerRuns || [],
      probes: probes.map((item) => ({ runId: item.runId, sourceId: item.sourceId, verificationState: item.probe.verificationState, counts: item.probe.counts })),
      probeQueue: {
        eligibleSources: probeBacklog.length,
        selectedSources: probeCandidates.length,
        remainingSources: Math.max(0, probeBacklog.length - probeCandidates.length),
        selectedSourceIds: probeCandidates.map((source) => source.id),
      },
      collection,
      approvalBoundary: "新来源即使探测成功，也只进入 pending；必须由人工审核后才可采集。",
    };
  }

  async runJobUpdate({ commitApproved = false, maxCollections = 100 } = {}) {
    const startedAt = new Date(this.now()).toISOString();
    const state = await this.registry.snapshot();
    const dueSources = state.sources
      .filter((source) => source.lifecycle === "approved" && source.collectionEnabled)
      .map((source) => ({ source, due: collectionDueState(source, this.now()) }))
      .filter((item) => item.due.due)
      .sort((left, right) => String(left.due.dueAt || "").localeCompare(String(right.due.dueAt || "")) || left.source.id.localeCompare(right.source.id))
      .slice(0, Math.max(0, Number(maxCollections) || 0));
    const runs = [];
    const errors = [];
    const safetyDowngrades = [];
    for (const { source } of dueSources) {
      try {
        runs.push(await this.collectJobs({ sourceId: source.id, commit: commitApproved }));
      } catch (error) {
        if (isLocalControlError(error)) throw error;
        if (["ROBOTS_DISALLOWED", "ROBOTS_ACCESS_RESTRICTED"].includes(error.code)) {
          const verificationState = error.code === "ROBOTS_DISALLOWED" ? "blocked_robots" : "access_restricted";
          await this.registry.recordProbe(source.id, {
            schemaVersion: "huangque.probe.v1",
            sourceId: source.id,
            probedAt: new Date(this.now()).toISOString(),
            verificationState,
            collectable: false,
            strategy: "none",
            robots: error.robots || null,
            evidence: error.robots ? [{ kind: "robots", ...error.robots }] : [],
            errors: [{ code: error.code, message: error.message }],
            edges: [],
            sampleJobs: [],
            counts: { total: 0, china: 0, beijing: 0 },
          }, error.runId || null);
          safetyDowngrades.push({ sourceId: source.id, code: error.code, message: error.message, runId: error.runId || null });
          continue;
        }
        errors.push({ sourceId: source.id, code: error.code || "COLLECTION_FAILED", message: error.message, runId: error.runId || null });
      }
    }
    const incompleteSources = runs.reduce((sum, run) => sum + Number(run.stats?.sourcesIncomplete || 0), 0);
    const status = errors.length ? "failed"
      : incompleteSources ? "completed_with_findings"
        : safetyDowngrades.length ? "completed_with_findings"
          : dueSources.length === 0 ? "no_work" : "completed";
    return {
      schemaVersion: "huangque.job-update.v1",
      startedAt,
      completedAt: new Date(this.now()).toISOString(),
      status,
      commit: commitApproved,
      dueSources: dueSources.length,
      completedSources: runs.length,
      incompleteSources,
      safetyDowngradedSources: safetyDowngrades.length,
      failedSources: errors.length,
      runIds: runs.map((run) => run.runId),
      sourceRuns: runs.map((run) => ({
        runId: run.runId,
        stats: run.stats,
        errors: run.errors,
        evidence: run.results.map(collectionEvidenceSummary),
      })),
      safetyDowngrades,
      errors,
      separationBoundary: "此任务只更新已批准来源，不执行来源发现或候选探测。",
    };
  }

  async runDue({ commitApproved = false, maxCollections = 100 } = {}) {
    return this.runJobUpdate({ commitApproved, maxCollections });
  }

  async runSourceSpider({ maxEmployers = 100, maxProbes = 20, maxCrawlPages = 20, deep = false, providers } = {}) {
    return executeSourceSpider(this, {
      universePath: this.employerUniversePath,
      statePath: this.sourceSpiderStatePath,
      maxEmployers,
      maxProbes,
      maxCrawlPages,
      deep,
      providers,
    });
  }

  async listSources({ lifecycle = null, verificationState = null, provinceCode = null, cityCode = null, limit = 100, cursor = 0 } = {}) {
    const state = await this.registry.snapshot();
    const filtered = state.sources
      .filter((source) => !lifecycle || source.lifecycle === lifecycle)
      .filter((source) => !verificationState || source.verificationState === verificationState)
      .filter((source) => !provinceCode && !cityCode || (source.candidate?.regions || []).some((region) => (!provinceCode || region.provinceCode === provinceCode || region.provinceCode === null) && (!cityCode || region.cityCode === cityCode || region.cityCode === null)))
      .sort((left, right) => String(right.lastDiscoveredAt).localeCompare(String(left.lastDiscoveredAt)) || left.id.localeCompare(right.id));
    const start = Math.max(0, Number(cursor) || 0);
    const items = filtered.slice(start, start + Math.min(200, Math.max(1, Number(limit) || 100)));
    return { sources: items, total: filtered.length, nextCursor: start + items.length < filtered.length ? start + items.length : null };
  }

  async listJobs({ status = null, provinceCode = null, cityCode = null, limit = 100, cursor = 0 } = {}) {
    const state = await this.registry.snapshot();
    const activeSourceIds = new Set(state.sources.filter((source) => source.lifecycle === "approved" && source.collectionEnabled).map((source) => source.id));
    const sourceRoots = new Map(state.sources.map((source) => [source.id, source.candidate?.sourceRootUrl]).filter((entry) => entry[1]));
    const filtered = state.jobs
      .filter((job) => (job.sourceIds || [job.sourceId]).some((sourceId) => activeSourceIds.has(sourceId)))
      .filter((job) => job.status !== "quarantined")
      .map((job) => resolveHostedJob(job, activeSourceIds, sourceRoots, this.now()).job)
      .filter((job) => !status || job.status === status)
      .filter((job) => jobMatchesRegion(job, { provinceCode, cityCode }));
    const start = Math.max(0, Number(cursor) || 0);
    const jobs = filtered.slice(start, start + Math.min(500, Math.max(1, Number(limit) || 100)));
    return { jobs, total: filtered.length, nextCursor: start + jobs.length < filtered.length ? start + jobs.length : null };
  }

  async listRegions({ provinceCode = null } = {}) {
    const state = await this.registry.snapshot();
    const provinceJobs = new Map();
    const provinceOnlyJobs = new Map();
    const cityJobs = new Map();
    for (const job of state.jobs) for (const region of job.workLocations || job.regions || []) {
      if (!region.provinceCode) continue;
      if (!provinceJobs.has(region.provinceCode)) provinceJobs.set(region.provinceCode, new Set());
      provinceJobs.get(region.provinceCode).add(job.id);
      if (region.cityCode) {
        if (!cityJobs.has(region.cityCode)) cityJobs.set(region.cityCode, new Set());
        cityJobs.get(region.cityCode).add(job.id);
      } else {
        if (!provinceOnlyJobs.has(region.provinceCode)) provinceOnlyJobs.set(region.provinceCode, new Set());
        provinceOnlyJobs.get(region.provinceCode).add(job.id);
      }
    }
    return {
      schemaVersion: "huangque.regions.v1",
      dataVersion: "2025-12-31",
      scope: "中国省级及地级二级分类",
      regions: listChinaRegions({ provinceCode }).map((province) => ({
        ...province,
        jobCount: provinceJobs.get(province.provinceCode)?.size || 0,
        provinceOnlyJobCount: provinceOnlyJobs.get(province.provinceCode)?.size || 0,
        cities: province.cities.map((city) => ({ ...city, jobCount: cityJobs.get(city.cityCode)?.size || 0 })),
      })),
    };
  }

  async getSourceGraph({ sourceId = null, relationType = null, limit = 200, cursor = 0 } = {}) {
    const state = await this.registry.snapshot();
    const filtered = state.edges
      .filter((edge) => !sourceId || edge.from === sourceId)
      .filter((edge) => !relationType || edge.type === relationType)
      .sort((left, right) => String(right.lastObservedAt || "").localeCompare(String(left.lastObservedAt || "")) || left.id.localeCompare(right.id));
    const start = Math.max(0, Number(cursor) || 0);
    const edges = filtered.slice(start, start + Math.min(500, Math.max(1, Number(limit) || 200)));
    return { summary: graphSummary({ ...state, edges: filtered }), edges, total: filtered.length, nextCursor: start + edges.length < filtered.length ? start + edges.length : null };
  }

  async getRun(runId) {
    const run = await this.registry.getRun(runId);
    if (!run) throw Object.assign(new Error(`运行不存在：${runId}`), { code: "RUN_NOT_FOUND" });
    return run;
  }

  async exportHostedProjection({ outputPath = resolve(this.runtimeRoot, "hosted-snapshot.json") } = {}) {
    const state = await this.registry.snapshot();
    // Freshness is evaluated at export time. Reusing Registry.updatedAt would
    // freeze the 14-day clock whenever no state mutation occurs and could keep
    // stale jobs visible indefinitely across repeated exports.
    const projection = buildHostedProjection(state, { generatedAt: new Date(this.now()).toISOString() });
    await writeJsonAtomically(outputPath, projection);
    return {
      path: outputPath,
      revision: projection.revision,
      manifest: projection.metadata.hostedProjection,
    };
  }

  async audit({ outputPath = null, schedulerObservation = null } = {}) {
    const now = new Date(this.now());
    const [state, status, plan, universe, spiderState] = await Promise.all([
      this.registry.snapshot(),
      this.status(),
      readJson(this.queryPlanPath, "查询计划"),
      loadEmployerUniverse(this.employerUniversePath),
      readSourceSpiderState(this.sourceSpiderStatePath, now),
    ]);
    const paths = {
      dailyScript: resolve(this.projectRoot, "scripts/huangque/daily-update.mjs"),
      spiderScript: resolve(this.projectRoot, "scripts/huangque/source-spider-update.mjs"),
      collector: resolve(this.projectRoot, "scripts/huangque/lib/collector.mjs"),
      registry: resolve(this.projectRoot, "scripts/huangque/lib/registry.mjs"),
      stateBundle: resolve(this.projectRoot, "scripts/huangque/state-bundle.mjs"),
      dailyWorkflow: resolve(this.projectRoot, ".github/workflows/daily-oriole.yml"),
      spiderWorkflow: resolve(this.projectRoot, ".github/workflows/source-spider.yml"),
      employerWorkflow: resolve(this.projectRoot, ".github/workflows/employer-universe-refresh.yml"),
      recoveryWorkflow: resolve(this.projectRoot, ".github/workflows/state-recovery-audit.yml"),
    };
    const [
      dailyScriptText,
      spiderScriptText,
      collectorText,
      registryText,
      stateBundleText,
      dailyWorkflowText,
      spiderWorkflowText,
      employerWorkflowText,
      recoveryWorkflowText,
      latestJobUpdate,
      latestSpider,
      latestRecovery,
      persistedJobDates,
      persistedSpiderDates,
    ] = await Promise.all([
      readFile(paths.dailyScript, "utf8").catch(() => ""),
      readFile(paths.spiderScript, "utf8").catch(() => ""),
      readFile(paths.collector, "utf8").catch(() => ""),
      readFile(paths.registry, "utf8").catch(() => ""),
      readFile(paths.stateBundle, "utf8").catch(() => ""),
      readFile(paths.dailyWorkflow, "utf8").catch(() => ""),
      readFile(paths.spiderWorkflow, "utf8").catch(() => ""),
      readFile(paths.employerWorkflow, "utf8").catch(() => ""),
      readFile(paths.recoveryWorkflow, "utf8").catch(() => ""),
      readJson(resolve(this.runtimeRoot, "latest-job-update.json"), "岗位更新运行记录").catch(() => null),
      readJson(resolve(this.runtimeRoot, "latest-source-spider.json"), "寻源蜘蛛运行记录").catch(() => null),
      readJson(resolve(this.runtimeRoot, "latest-state-recovery.json"), "状态恢复审计记录").catch(() => null),
      successfulReceiptDates(resolve(this.runtimeRoot, "job-updates"), ["completed", "completed_with_findings", "no_work"]),
      successfulReceiptDates(resolve(this.runtimeRoot, "source-spider-runs"), ["completed", "completed_with_findings"], (receipt) => receipt?.onlineEvidence?.present === true),
    ]);
    const currentJobSchedulerLive = schedulerObservationIsLive(schedulerObservation);
    const jobSchedulerRecent = currentJobSchedulerLive || (
      latestJobUpdate?.trigger === "github_actions"
      && receiptIsRecent(latestJobUpdate, now, 36, ["completed", "completed_with_findings", "no_work"])
    );
    const spiderSchedulerRecent = latestSpider?.trigger === "github_actions"
      && latestSpider?.onlineEvidence?.present === true
      && receiptIsRecent(latestSpider, now, 36, ["completed", "completed_with_findings"]);
    const recoveryRecent = recoveryReceiptVerified(latestRecovery)
      && receiptIsRecent(latestRecovery, now, 8 * 24, ["completed"]);
    const jobDates = new Set(persistedJobDates);
    if (currentJobSchedulerLive && schedulerObservation?.scheduledDate) jobDates.add(schedulerObservation.scheduledDate);
    const spiderDates = new Set(persistedSpiderDates);
    const activeSourceIds = new Set(state.sources.filter((source) => source.lifecycle === "approved" && source.collectionEnabled).map((source) => source.id));
    const planTaskIds = new Set(expandQueryPlan(plan).map((task) => task.id));
    const providerObservations = [
      ...Object.values(state.providerObservations || {}).map((checkpoint) => ({
        ...checkpoint,
        completedAt: checkpoint.observedAt,
      })),
      ...state.runs.flatMap((run) => (run.providerRuns || []).map((providerRun) => ({
        ...providerRun,
        parentRunId: run.id,
        parentRunStatus: run.status,
        completedAt: run.completedAt,
      }))),
    ];
    const recentProvider = (provider, maximumHours, predicate = () => true) => providerObservations.some((run) => (
      run.provider === provider
      && run.status === "ok"
      && run.parentRunStatus !== "failed"
      && observationIsRecent(run.completedAt, now, maximumHours)
      && predicate(run)
    ));
    const requiredGraphTypes = ["published_by", "covers_region", "has_entry_point", "discovered_via"];
    const graph = graphSummary(state);
    const requiredUniverseSources = new Set([
      "curated-priority-employers",
      "sasac-central-enterprises",
      "sse-main-a",
      "sse-star-a",
      "szse-a",
    ]);
    const universeComplete = universe.targets.length >= 5_000
      && universe.metadata?.completeness === "bounded_official_directory_universe"
      && universe.metadata?.complete === true
      && universe.sources?.length === requiredUniverseSources.size
      && universe.sources.every((source) => requiredUniverseSources.has(source.id));
    const queue = sourceSpiderQueueSummary(universe, state, spiderState, now);
    const bilingualTools = HUANGQUE_TOOLS.every((tool) => /[\p{Script=Han}]/u.test(`${tool.title} ${tool.description}`)
      && /[A-Za-z]/.test(`${tool.title} ${tool.description}`));
    const jobScheduleConfigured = /cron:\s*["']17 16 \* \* \*["']/.test(dailyWorkflowText)
      && /TZ:\s*Asia\/Shanghai/.test(dailyWorkflowText);
    const spiderSchedulesConfigured = /cron:\s*["']30 18 \* \* \*["']/.test(spiderWorkflowText)
      && /cron:\s*["']30 19 \* \* 6["']/.test(spiderWorkflowText)
      && /TZ:\s*Asia\/Shanghai/.test(spiderWorkflowText);
    const employerRefreshConfigured = /cron:\s*["']15 17 \* \* 6["']/.test(employerWorkflowText)
      && /refresh-employers/.test(employerWorkflowText)
      && /state-data\/employer-universe\.json/.test(employerWorkflowText)
      && [dailyWorkflowText, spiderWorkflowText].every((text) => /HUANGQUE_EMPLOYER_UNIVERSE_PATH/.test(text));
    const durableStateConfigured = [dailyWorkflowText, spiderWorkflowText, employerWorkflowText, recoveryWorkflowText].every((text) => (
      /ref:\s*oriole-state/.test(text)
      && /git push[\s\S]*?oriole-state/.test(text)
      && /group:\s*oriole-state-writer/.test(text)
      && /queue:\s*max/.test(text)
      && !/actions\/cache/.test(text)
    ));
    const registryBundleConfigured = [dailyWorkflowText, spiderWorkflowText].every((text) => (
      /state-bundle\.mjs unpack/.test(text)
      && /state-bundle\.mjs pack/.test(text)
      && /registry\.json\.gz/.test(text)
      && /registry\.bundle-manifest\.json/.test(text)
      && /rm -f -- state-data\/registry\.json/.test(text)
      && !/git add -A -- state-data(?:\s|$)/m.test(text)
    )) && /MAX_COMPRESSED_BUNDLE_BYTES\s*=\s*90 \* 1024 \* 1024/.test(stateBundleText);
    const checks = [
      { id: "employer_universe", category: "implementation", passed: universeComplete, detail: `官方有界目标库 ${universe.targets.length} 家；来源 ${universe.sources?.length || 0} 个；${universe.metadata?.allSourcesLive ? "本次全为在线目录" : "含明确标注的版本快照"}` },
      { id: "independent_job_updater", category: "implementation", passed: /\.runJobUpdate\s*\(/.test(dailyScriptText) && !/\.runPipeline\s*\(/.test(dailyScriptText), detail: "岗位更新脚本只刷新 approved 来源，不执行寻源或探测" },
      { id: "independent_source_spider", category: "implementation", passed: /runSourceSpider\s*\(/.test(spiderScriptText) && !/reviewSource\s*\(/.test(spiderScriptText), detail: "寻源蜘蛛独立运行，新线索只进入 candidate/probed 审核边界" },
      { id: "job_scheduler_config", category: "implementation", passed: jobScheduleConfigured, detail: jobScheduleConfigured ? "北京时间每日 00:17 独立更新岗位" : "岗位更新 cron 或 Asia/Shanghai 配置不完整" },
      { id: "spider_scheduler_config", category: "implementation", passed: spiderSchedulesConfigured, detail: spiderSchedulesConfigured ? "北京时间每日 02:30 寻源，周日 03:30 深扫" : "寻源每日/每周 cron 或时区配置不完整" },
      { id: "employer_universe_refresh", category: "implementation", passed: employerRefreshConfigured, detail: employerRefreshConfigured ? "北京时间每周日 01:15 原子刷新目标库，日更与蜘蛛读取同一持久快照" : "目标库刷新计划或持久快照接线不完整" },
      { id: "durable_state", category: "implementation", passed: durableStateConfigured, detail: "Registry、队列和收据写入 oriole-state；所有写者共享排队锁，未使用易失 cache 充当数据库" },
      { id: "registry_state_bundle", category: "implementation", passed: registryBundleConfigured, detail: "Registry 以带双 SHA-256 manifest 的 gzip 包持久化，90 MiB Git 对象硬保护；工作区明文不提交" },
      { id: "recovery_workflow", category: "implementation", passed: /state-bundle\.mjs unpack/.test(recoveryWorkflowText)
        && /--source-state-dir/.test(recoveryWorkflowText)
        && /--state-commit-sha/.test(recoveryWorkflowText)
        && /--force-with-lease=refs\/heads\/oriole-state:/.test(recoveryWorkflowText)
        && /git commit-tree/.test(recoveryWorkflowText), detail: "独立恢复演练校验完整状态清单与状态包，并以精确租约压缩专用分支历史" },
      { id: "incremental_http", category: "implementation", passed: /if-none-match/i.test(collectorText) && /lastSuccessfulCheckAt/.test(registryText) && /notModified/.test(registryText), detail: "支持 ETag/Last-Modified、304 不推进失联计数及最后成功检查时间" },
      { id: "national_scope", category: "implementation", passed: plan.scope === "全国" && listChinaRegions().length === 34 && expandQueryPlan(plan).length === 833, detail: `${plan.scope}查询计划；34 个省级区域、365 个二级分类项、833 个任务` },
      { id: "portable_agent", category: "implementation", passed: HUANGQUE_TOOLS.length === 18 && bilingualTools, detail: `${HUANGQUE_TOOLS.length} 个中英双语 MCP 工具；stdio JSON-RPC 可由支持 MCP 的 LLM 客户端调用` },
      { id: "source_queue_bound", category: "implementation", passed: queue.total === universe.targets.length && queue.total >= 5_000, detail: `寻源优先队列以全部 ${queue.total} 个目标为分母，按覆盖、等级、失败退避动态排序` },

      { id: "approval_gate", category: "integrity", passed: state.sources.every((source) => source.lifecycle === "approved" ? source.collectionEnabled && source.verificationState === "verified" : !source.collectionEnabled), detail: "只有 verified + approved 来源启用岗位采集" },
      { id: "new_sources_need_review", category: "integrity", passed: state.sources.filter((source) => source.lifecycle === "probed" && source.verificationState === "verified").every((source) => source.reviewStatus === "pending"), detail: "探测成功不会自动批准" },
      { id: "active_job_support", category: "integrity", passed: state.jobs.every((job) => job.status === "quarantined" || (job.sourceIds || [job.sourceId]).some((sourceId) => activeSourceIds.has(sourceId))), detail: "非隔离岗位至少保留一个 approved + enabled 来源支持" },
      { id: "validity_state", category: "integrity", passed: state.jobs.every((job) => !job.validThrough || new Date(job.validThrough) >= now || ["closed", "quarantined"].includes(job.status)), detail: "已过 validThrough 的岗位不能保持 active" },
      { id: "query_progress", category: "integrity", passed: Object.values(state.bucketState).every((bucket) => (bucket.completedTaskIds || []).every((taskId) => planTaskIds.has(taskId))), detail: "查询桶只记录当前计划中的逐任务进度" },
      { id: "provider_checkpoints", category: "integrity", passed: Object.values(state.providerObservations || {}).every((checkpoint) => {
        const observedAt = new Date(checkpoint?.observedAt || 0);
        return checkpoint?.status === "ok" && !Number.isNaN(observedAt.getTime()) && observedAt <= new Date(now.getTime() + 5 * 60_000);
      }), detail: "Provider 最近成功观察独立于有界 run 历史保存，不因 50 条运行保留策略丢失" },
      { id: "graph_evidence", category: "integrity", passed: state.edges.every((edge) => Boolean(edge.evidence)) && (state.edges.length === 0 || graph.evidenceCoverage === 1), detail: `当前 ${state.edges.length} 条关系的证据覆盖 ${Math.round(graph.evidenceCoverage * 100)}%` },

      { id: "source_registry_present", category: "operational", passed: state.sources.length > 0, detail: state.sources.length ? `当前持久 Registry 有 ${state.sources.length} 个来源` : "尚无真实来源记录" },
      { id: "source_queue_observed", category: "operational", passed: spiderState.runs.length > 0 && Object.keys(spiderState.targets).length > 0, detail: `持久寻源历史 ${spiderState.runs.length} 次，已有 ${Object.keys(spiderState.targets).length}/${queue.total} 个目标产生尝试状态` },
      { id: "job_traceability", category: "operational", passed: state.jobs.length > 0 && state.jobs.every((job) => job.sourceId && job.sourceUrl && job.evidence?.length), detail: state.jobs.length ? `已检查 ${state.jobs.length} 个真实岗位的来源与证据` : "当前 Registry 无真实岗位，不能用测试 fixture 代替" },
      { id: "job_region_classification", category: "operational", passed: state.jobs.length > 0 && state.jobs.every((job) => Array.isArray(job.workLocations || job.regions) && (job.workLocations || job.regions).length > 0), detail: state.jobs.length ? `已检查 ${state.jobs.length} 个岗位的结构化上班地点` : "当前 Registry 尚无真实岗位" },
      { id: "registry_graph", category: "operational", passed: state.sources.length > 0 && state.edges.length > 0 && requiredGraphTypes.every((type) => state.edges.some((edge) => edge.type === type)), detail: `图谱 ${graph.nodes} 个节点、${graph.edges} 条关系；类型 ${Object.keys(graph.byType).join("、") || "无"}` },
      { id: "baidu_recent", category: "operational", passed: recentProvider("baidu", 35 * 24, (run) => Number(run.metadata?.requestCount || 0) > 0), detail: "要求最近 35 天内有百度官方 API 的真实成功请求记录" },
      { id: "common_crawl_recent", category: "operational", passed: recentProvider("common_crawl", 35 * 24, (run) => Boolean(run.metadata?.indexId)), detail: "要求最近 35 天内有 Common Crawl URL Index 的真实索引记录" },
      { id: "official_catalog_recent", category: "operational", passed: recentProvider("official_catalog", 10 * 24, (run) => Number(run.hits || 0) > 0), detail: "要求最近 10 天内成功导入版本化公开目录；目录线索不等于已批准来源" },
      { id: "job_scheduler_recent", category: "operational", passed: jobSchedulerRecent, detail: jobSchedulerRecent ? "最近 36 小时内有 GitHub Actions 岗位更新成功凭据" : "尚无最近 36 小时的线上岗位更新成功凭据" },
      { id: "spider_scheduler_recent", category: "operational", passed: spiderSchedulerRecent, detail: spiderSchedulerRecent ? "最近 36 小时内有 GitHub Actions 寻源及真实网络成功凭据" : "尚无最近 36 小时的线上寻源真实网络成功凭据；仅 imported 清单运行不计" },
      { id: "state_recovery_recent", category: "operational", passed: recoveryRecent, detail: recoveryRecent ? "最近 8 天内已从持久分支恢复并验证状态" : "尚无最近 8 天的线上恢复演练成功凭据" },

      { id: "job_scheduler_two_days", category: "maturity", passed: jobDates.size >= 2, detail: `不同自然日的线上岗位更新成功凭据：${[...jobDates].sort().join("、") || "无"}` },
      { id: "spider_scheduler_two_days", category: "maturity", passed: spiderDates.size >= 2, detail: `不同自然日的线上寻源成功凭据：${[...spiderDates].sort().join("、") || "无"}` },
    ];
    const categoryPassed = (category) => checks.filter((check) => check.category === category).every((check) => check.passed);
    const report = {
      schemaVersion: "huangque.audit.v2",
      generatedAt: now.toISOString(),
      definition: status.definition,
      status,
      checks,
      result: {
        passed: checks.filter((check) => check.passed).length,
        failedOrBlocked: checks.filter((check) => !check.passed).length,
        implementationComplete: categoryPassed("implementation"),
        stateIntegrityPassed: categoryPassed("integrity"),
        operationalNow: categoryPassed("operational"),
        maturityObserved: categoryPassed("maturity"),
        fullyOperational: checks.every((check) => check.passed),
        scope: "实现、当前数据、线上运行与跨天成熟度分别判定；代码回归仍必须以 npm test 和 GitHub CI 的独立输出为准。",
      },
      implementation: {
        discovery: ["5000+ bounded official employer universe", "persistent priority/backoff queue", "BaiduWebSearchProvider", "CommonCrawlCdxProvider", "OfficialCatalogProvider", "same-origin employer crawler", "Imported/UserSubmissionProvider"],
        probe: ["HTTPS only", "DNS pinning", "cross-origin redirect blocked", "per-hop robots redirect guard", "timeout", "response size", "login/challenge detection", "ATS/JSON-LD/HTML listing inspection"],
        registry: ["candidate/probed/approved/rejected lifecycle", "optimistic revision", "cross-process file lock", "durable gzip state bundle on oriole-state", "persistent provider checkpoints", "source/employer/job evidence graph", "content-addressed raw artifacts"],
        collection: ["Lever", "Greenhouse", "Ashby", "ByteDance/Feishu Recruitment public search APIs", "NCSS flexible JSON", "全国及地方公共就业", "JobPosting JSON-LD", "RSS/Atom", "Sitemap XML", "government HTML listing"],
        jobs: ["huangque.job.v2 structured workLocations", "34 province-level and 365 second-level classifications", "multi-location preservation", "cross-source canonical apply URL dedupe", "persistent soft duplicate review queue", "content version history", "authoritative complete-feed missing thresholds", "ETag/Last-Modified conditional collection", "three evidence scores"],
      },
      agent: {
        transport: "MCP stdio NDJSON",
        protocols: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        tools: HUANGQUE_TOOLS.map((tool) => tool.name),
        cli: "node scripts/huangque/cli.mjs",
        deterministicCore: true,
      },
      persistence: {
        portableAgent: "atomic JSON registry + content-addressed gzip artifacts",
        hostedAutomation: "SHA-256 manifested Registry gzip bundle, spider queue and receipts on the durable oriole-state branch; 30-day raw run artifacts",
        hostedProjection: "bounded deterministic confirmed-active projection for external hosts; complete data remains in Registry",
      },
      employerUniverse: {
        metadata: universe.metadata,
        stats: universe.stats,
        queue,
      },
      schedulerEvidence: {
        latestJobUpdate,
        latestSourceSpider: latestSpider,
        latestStateRecovery: latestRecovery,
        successfulJobDates: [...jobDates].sort(),
        successfulSpiderDates: [...spiderDates].sort(),
      },
      recentRuns: state.runs.slice(0, 20),
      sources: state.sources,
      graph: state.edges,
      jobStats: {
        total: state.jobs.length,
        active: state.jobs.filter((job) => job.status === "confirmed_active").length,
        needsReview: state.jobs.filter((job) => job.status === "needs_review").length,
        closed: state.jobs.filter((job) => job.status === "closed").length,
      },
      exclusions: ["微信群", "图片 OCR", "邮件", "需登录或验证码的私域来源"],
    };
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeJsonAtomically(outputPath, report);
    }
    return report;
  }
}
