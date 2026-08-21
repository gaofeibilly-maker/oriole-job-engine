import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
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

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取${label} ${path}：${error.message}`);
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
    && String(observation?.runId || "") === String(env.GITHUB_RUN_ID);
}

export class HuangqueEngine {
  constructor({
    projectRoot,
    registryPath = resolve(projectRoot, ".huangque/state.json"),
    artifactRoot = resolve(projectRoot, ".huangque/artifacts"),
    queryPlanPath = resolve(projectRoot, "data/huangque/national-query-plan.json"),
    sourceChannelPlanPath = resolve(projectRoot, "data/huangque/source-channel-plan.json"),
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
    this.queryPlanPath = queryPlanPath;
    this.sourceChannelPlanPath = sourceChannelPlanPath;
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
    const [state, plan] = await Promise.all([this.registry.snapshot(), readJson(this.queryPlanPath, "查询计划")]);
    const sourceCounts = Object.fromEntries(["candidate", "probed", "approved", "rejected"].map((lifecycle) => [lifecycle, state.sources.filter((source) => source.lifecycle === lifecycle).length]));
    const regionCounts = {};
    for (const job of state.jobs) for (const region of job.workLocations || job.regions || []) regionCounts[region.label] = Number(regionCounts[region.label] || 0) + 1;
    const providerRuns = state.runs.flatMap((run) => run.providerRuns || []);
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
    return analyzeSourceCoverage({
      projectRoot: this.projectRoot,
      registry: this.registry,
      queryPlanPath: this.queryPlanPath,
      channelPlanPath: this.sourceChannelPlanPath,
    });
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
      await this.registry.finishRun(run.id, {
        status: "completed",
        stats,
        providerRuns: input.metadata.providerRuns,
        errors: providerErrors(input.metadata.providerRuns),
        output: { sourceIds: discovery.candidates.map((candidate) => candidate.id), blockedTaskIds: stats.blockedTaskIds },
      });
      return { runId: run.id, tasks, blockedTasks, input, discovery, stats };
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
      try {
        const result = await collectApprovedSource(this.registry, id, {
          commit,
          runId: run.id,
          now: this.now(),
          fetchOptions: { ...this.fetchOptions, requestPhase: "collection" },
          artifactStore: this.artifactStore,
        });
        if (commit) await this.registry.recordCollectionAttempt(id, { runId: run.id, success: true, commit, cadenceHours: collectionCadenceHours(state.sources.find((source) => source.id === id)) });
        results.push(result);
      } catch (error) {
        failedArtifacts.push(...(error.artifacts || []).map((artifact) => ({ sourceId: id, ...artifact })));
        if (commit && !isLocalControlError(error) && !["SOURCE_NOT_APPROVED", "SOURCE_NOT_FOUND"].includes(error.code)) {
          await this.registry.recordCollectionAttempt(id, {
            runId: run.id,
            success: false,
            commit,
            cadenceHours: collectionCadenceHours(state.sources.find((source) => source.id === id)),
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
    return {
      schemaVersion: "huangque.pipeline.v1",
      discoveryRunId: discovery.runId,
      discovered: discovery.discovery.stats,
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

  async runDue({ commitApproved = false, maxQueries = 20, maxProbes = 10, maxCollections = 20 } = {}) {
    const pipeline = await this.runPipeline({ maxQueries, maxProbes, collectApproved: false, commit: commitApproved, force: false });
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
    return {
      ...pipeline,
      collection: {
        commit: commitApproved,
        dueSources: dueSources.length,
        completedSources: runs.length,
        incompleteSources: runs.reduce((sum, run) => sum + Number(run.stats?.sourcesIncomplete || 0), 0),
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
      },
    };
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

  async exportHostedProjection({ outputPath = resolve(this.projectRoot, ".huangque/hosted-snapshot.json") } = {}) {
    const state = await this.registry.snapshot();
    const projection = buildHostedProjection(state, { generatedAt: state.metadata?.updatedAt || new Date(this.now()).toISOString() });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(projection)}\n`, "utf8");
    return {
      path: outputPath,
      revision: projection.revision,
      manifest: projection.metadata.hostedProjection,
    };
  }

  async audit({ outputPath = null, schedulerObservation = null } = {}) {
    const [state, status, plan] = await Promise.all([this.registry.snapshot(), this.status(), readJson(this.queryPlanPath, "查询计划")]);
    const [dailyScriptPresent, dailyWorkflowPresent, dailyWorkflowText, latestDaily] = await Promise.all([
      pathExists(resolve(this.projectRoot, "scripts/huangque/daily-update.mjs")),
      pathExists(resolve(this.projectRoot, ".github/workflows/daily-oriole.yml")),
      readFile(resolve(this.projectRoot, ".github/workflows/daily-oriole.yml"), "utf8").catch(() => ""),
      readJson(resolve(this.projectRoot, ".huangque/latest-daily.json"), "每日运行记录").catch(() => null),
    ]);
    const schedulerConfigured = dailyScriptPresent
      && dailyWorkflowPresent
      && /cron:\s*["']0 16 \* \* \*["']/.test(dailyWorkflowText)
      && /TZ:\s*Asia\/Shanghai/.test(dailyWorkflowText);
    const currentSchedulerLive = schedulerObservationIsLive(schedulerObservation);
    const schedulerLive = currentSchedulerLive || latestDaily?.status === "completed" && latestDaily?.trigger === "github_actions";
    const schedulerLiveDate = currentSchedulerLive ? schedulerObservation.scheduledDate : latestDaily?.scheduledDate;
    const activeSourceIds = new Set(state.sources.filter((source) => source.lifecycle === "approved" && source.collectionEnabled).map((source) => source.id));
    const planTaskIds = new Set(expandQueryPlan(plan).map((task) => task.id));
    const providerRuns = state.runs.flatMap((run) => run.providerRuns || []);
    const requiredGraphTypes = ["published_by", "covers_region", "has_entry_point", "discovered_via"];
    const graph = graphSummary(state);
    const checks = [
      { id: "source_registry_present", passed: state.sources.length > 0, detail: state.sources.length ? `当前审计包含 ${state.sources.length} 个来源记录` : "空 Registry 不能证明实现或运行闭环" },
      { id: "approval_gate", passed: state.sources.every((source) => source.lifecycle === "approved" ? source.collectionEnabled && source.verificationState === "verified" : !source.collectionEnabled), detail: "只有 verified + approved 来源启用采集" },
      { id: "new_sources_need_review", passed: state.sources.filter((source) => source.lifecycle === "probed" && source.verificationState === "verified").every((source) => source.reviewStatus === "pending"), detail: "探测成功不会自动批准" },
      { id: "job_traceability", passed: state.jobs.length > 0 && state.jobs.every((job) => job.sourceId && job.sourceUrl && job.evidence?.length), detail: state.jobs.length ? `已检查 ${state.jobs.length} 个岗位的来源与证据` : "当前审计 Registry 无岗位，不能把测试 fixture 冒充真实在线采集" },
      { id: "active_job_support", passed: state.jobs.every((job) => job.status === "quarantined" || (job.sourceIds || [job.sourceId]).some((sourceId) => activeSourceIds.has(sourceId))), detail: "非隔离岗位至少保留一个 approved + enabled 来源支持" },
      { id: "validity_state", passed: state.jobs.every((job) => !job.validThrough || new Date(job.validThrough) >= this.now() || ["closed", "quarantined"].includes(job.status)), detail: "已过 validThrough 的岗位不能保持 active" },
      { id: "query_progress", passed: Object.values(state.bucketState).every((bucket) => (bucket.completedTaskIds || []).every((taskId) => planTaskIds.has(taskId))), detail: "查询桶只记录当前计划中的逐任务进度，完整一轮后才推进 cadence" },
      { id: "national_scope", passed: plan.scope === "全国" && listChinaRegions().length === 34, detail: `${plan.scope}查询计划；34 个省级区域、365 个地级/省直辖分类项` },
      { id: "job_region_classification", passed: state.jobs.length > 0 && state.jobs.every((job) => Array.isArray(job.workLocations || job.regions) && (job.workLocations || job.regions).length > 0), detail: state.jobs.length ? `检查 ${state.jobs.length} 个岗位的结构化上班地点` : "当前 Registry 尚无真实岗位" },
      { id: "registry_graph", passed: state.sources.length > 0 && state.edges.length > 0 && requiredGraphTypes.every((type) => state.edges.some((edge) => edge.type === type)), detail: `图谱 ${graph.nodes} 个节点、${graph.edges} 条关系；类型 ${Object.keys(graph.byType).join("、") || "无"}` },
      { id: "graph_evidence", passed: state.edges.length > 0 && graph.evidenceCoverage === 1, detail: `关系证据覆盖 ${Math.round(graph.evidenceCoverage * 100)}%` },
      { id: "baidu_live", passed: providerRuns.some((run) => run.provider === "baidu" && run.status === "ok" && Number(run.metadata?.requestCount || 0) > 0), detail: "要求 Registry 中存在百度官方 API 的真实成功请求记录" },
      { id: "common_crawl_live", passed: providerRuns.some((run) => run.provider === "common_crawl" && run.status === "ok" && Boolean(run.metadata?.indexId)), detail: "要求 Registry 中存在 Common Crawl URL Index 的真实索引记录" },
      { id: "official_catalog_imported", passed: providerRuns.some((run) => run.provider === "official_catalog" && run.status === "ok" && Number(run.hits || 0) > 0), detail: "版本化全国官方公开目录已导入；这不等于每个目录链接都完成本轮在线探测" },
      { id: "external_scheduler", passed: schedulerConfigured, detail: schedulerConfigured ? "已解析并确认 cron 0 16 * * * + Asia/Shanghai，即北京时间每日 00:00" : "每日脚本或 GitHub Actions 的时区/cron 配置不完整" },
      { id: "scheduler_live", passed: schedulerLive, detail: schedulerLive ? `GitHub Actions 已执行到安全收尾阶段；最近日期：${schedulerLiveDate}` : "尚未在当前 Registry 看到 GitHub Actions 成功运行记录；发布后需检查首轮 Actions" },
    ];
    const report = {
      schemaVersion: "huangque.audit.v1",
      generatedAt: new Date(this.now()).toISOString(),
      definition: status.definition,
      status,
      checks,
      result: {
        passed: checks.filter((check) => check.passed).length,
        failedOrBlocked: checks.filter((check) => !check.passed).length,
        stateChecksPassed: checks.filter((check) => !["baidu_live", "common_crawl_live", "scheduler_live"].includes(check.id)).every((check) => check.passed),
        implementationComplete: checks.filter((check) => !["baidu_live", "common_crawl_live", "scheduler_live"].includes(check.id)).every((check) => check.passed),
        fullyOperational: checks.every((check) => check.passed),
        scope: "此报告只检查当前 Registry 状态与外部激活项；代码回归结果必须以 npm test 的独立输出为准。",
      },
      implementation: {
        discovery: ["BaiduWebSearchProvider", "CommonCrawlCdxProvider", "OfficialCatalogProvider", "Imported/UserSubmissionProvider", "cadence query plan"],
        probe: ["HTTPS only", "DNS pinning", "cross-origin redirect blocked", "per-hop robots redirect guard", "timeout", "response size", "login/challenge detection", "ATS/JSON-LD/HTML listing inspection"],
        registry: ["candidate/probed/approved/rejected lifecycle", "optimistic revision", "cross-process file lock", "bounded event/run/evidence retention", "source relations", "file store"],
        collection: ["Lever", "Greenhouse", "Ashby", "ByteDance/Feishu Recruitment public search APIs", "NCSS flexible JSON", "全国及地方公共就业", "JobPosting JSON-LD", "RSS/Atom", "Sitemap XML", "government HTML listing"],
        jobs: ["huangque.job.v2 structured workLocations", "34 province-level and 365 second-level classifications", "multi-location preservation", "cross-source canonical apply URL dedupe", "persistent soft duplicate review queue", "content version history", "authoritative complete-feed missing thresholds", "three evidence scores"],
      },
      agent: {
        transport: "MCP stdio NDJSON",
        protocols: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        tools: ["huangque.run_pipeline", "huangque.get_run", "huangque.status", "huangque.source_coverage", "huangque.discover_sources", "huangque.submit_source", "huangque.probe_source", "huangque.list_sources", "huangque.list_jobs", "huangque.list_regions", "huangque.get_source_graph", "huangque.review_source", "huangque.collect_jobs", "huangque.run_due", "huangque.export_hosted_projection", "huangque.audit"],
        cli: "node scripts/huangque/cli.mjs",
        deterministicCore: true,
      },
      persistence: {
        portableAgent: "atomic JSON registry + content-addressed gzip artifacts",
        hostedProjection: "bounded deterministic projection for an external host; this portable Agent release does not include a hosted database",
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
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  }
}
