import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listChinaRegions } from "./china-regions.mjs";
import { expandQueryPlan } from "./query-plan.mjs";

export const SOURCE_CHANNEL_PLAN_SCHEMA_VERSION = "huangque.source-channel-plan.v1";
export const SOURCE_COVERAGE_SCHEMA_VERSION = "huangque.source-coverage.v1";

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取${label} ${path}：${error.message}`);
  }
}

function uniqueIds(values, label) {
  const ids = values.map((value) => String(value?.id || "").trim());
  if (ids.some((id) => !id)) throw new TypeError(`${label}必须包含非空 id`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} id 不能重复`);
  return ids;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function validateSourceChannelPlan(plan) {
  if (!plan || plan.schemaVersion !== SOURCE_CHANNEL_PLAN_SCHEMA_VERSION) {
    throw new TypeError(`来源渠道计划必须符合 ${SOURCE_CHANNEL_PLAN_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(plan.channels) || plan.channels.length !== 9) {
    throw new TypeError("来源渠道计划必须恰好声明 9 类渠道");
  }
  if (plan.metadata?.nonExhaustive !== true || !plan.targetInventory?.scopeStatement) {
    throw new TypeError("来源渠道计划必须明确声明有限清单和非全互联网覆盖边界");
  }
  const channelIds = uniqueIds(plan.channels, "渠道");
  const channelIdSet = new Set(channelIds);
  for (const channel of plan.channels) {
    if (!channel.objective || typeof channel.directlyProducesJobs !== "boolean" || typeof channel.requiredForOperationalCoverage !== "boolean") {
      throw new TypeError(`渠道 ${channel.id} 必须包含 objective、directlyProducesJobs 与 requiredForOperationalCoverage`);
    }
    if (channel.targetCoverage?.mode && !["required_all", "informational"].includes(channel.targetCoverage.mode)) {
      throw new TypeError(`渠道 ${channel.id} 包含无效 targetCoverage.mode`);
    }
    const defaultHours = Number(channel.cadence?.defaultHours);
    if (!channel.cadence?.mode || !Number.isFinite(defaultHours) || defaultHours < 0) {
      throw new TypeError(`渠道 ${channel.id} 必须包含有效 cadence`);
    }
    for (const bucketId of asArray(channel.requiredQueryBucketIds)) {
      if (!String(bucketId || "").trim()) throw new TypeError(`渠道 ${channel.id} 包含无效查询桶`);
    }
  }
  const employers = plan.targetInventory?.employers;
  if (!Array.isArray(employers) || employers.length === 0) throw new TypeError("来源渠道计划必须包含有界重点企业清单");
  uniqueIds(employers, "重点企业");
  const targetSegments = new Set(employers.map((target) => target.segment));
  for (const requiredSegment of ["internet", "technology", "manufacturing", "central_state_owned"]) {
    if (!targetSegments.has(requiredSegment)) throw new TypeError(`重点企业清单缺少 ${requiredSegment} 分组`);
  }
  for (const target of employers) {
    if (!target.name || !target.segment || !asArray(target.match?.hosts).length) {
      throw new TypeError(`重点企业 ${target.id} 缺少名称、分组或可审计 host`);
    }
    if (!asArray(target.desiredChannelIds).length || target.desiredChannelIds.some((id) => !channelIdSet.has(id))) {
      throw new TypeError(`重点企业 ${target.id} 引用了未知渠道`);
    }
    let auditUrl;
    try { auditUrl = new URL(target.audit?.officialRecruitmentUrl); }
    catch { throw new TypeError(`重点企业 ${target.id} 缺少有效官方招聘 URL`); }
    if (auditUrl.protocol !== "https:") throw new TypeError(`重点企业 ${target.id} 的官方招聘 URL 必须使用 HTTPS`);
  }
  for (const channelId of asArray(plan.regionCoverage?.sourceChannelIds)) {
    if (!channelIdSet.has(channelId)) throw new TypeError(`地域覆盖规则引用了未知渠道 ${channelId}`);
  }
  return plan;
}

export async function loadSourceChannelPlan(path = resolve(defaultProjectRoot, "data/huangque/source-channel-plan.json")) {
  return validateSourceChannelPlan(await readJson(path, "来源渠道计划"));
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function regionNameKey(value) {
  return normalizedText(value)
    .replace(/(?:壮族|回族|维吾尔|特别行政|自治区|自治州|地区|盟|省|市)$/u, "");
}

function sourceCandidate(source) {
  return source?.candidate || {};
}

function sourceEvidenceChannels(source) {
  return new Set(asArray(sourceCandidate(source).evidence)
    .map((evidence) => String(evidence?.channel || "").trim())
    .filter(Boolean));
}

function sourceMatchesChannel(source, channel) {
  const match = channel.match || {};
  const candidate = sourceCandidate(source);
  const tests = [];
  if (asArray(match.sourceTypes).length) tests.push(asArray(match.sourceTypes).includes(candidate.sourceType));
  if (asArray(match.providers).length) tests.push(asArray(match.providers).includes(candidate.provider));
  if (asArray(match.evidenceChannels).length) {
    const evidenceChannels = sourceEvidenceChannels(source);
    tests.push(asArray(match.evidenceChannels).some((value) => evidenceChannels.has(value)));
  }
  if (asArray(match.probeStrategies).length) tests.push(asArray(match.probeStrategies).includes(source?.probe?.strategy));
  return tests.some(Boolean);
}

function sourceIsApproved(source) {
  return source?.lifecycle === "approved"
    && source?.verificationState === "verified"
    && source?.collectionEnabled === true;
}

function safeHostname(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

function sourceHostnames(source) {
  const candidate = sourceCandidate(source);
  return new Set([
    candidate.sourceRootUrl,
    candidate.publicApiUrl,
    candidate.entryUrl,
    source?.probe?.collectionEndpoint,
    ...asArray(candidate.discoveredUrls),
  ].map(safeHostname).filter(Boolean));
}

function hostnameMatches(actual, expected) {
  const normalizedExpected = String(expected || "").toLowerCase();
  return actual === normalizedExpected || actual.endsWith(`.${normalizedExpected}`);
}

function sourceMatchesTarget(source, target) {
  const hostnames = sourceHostnames(source);
  if (asArray(target.match?.hosts).some((expected) => [...hostnames].some((actual) => hostnameMatches(actual, expected)))) return true;
  const candidate = sourceCandidate(source);
  const sourceNames = [source?.name, candidate.name, candidate.publisher, candidate.tenant]
    .map(normalizedText)
    .filter(Boolean);
  return asArray(target.match?.publisherAliases)
    .map(normalizedText)
    .filter((alias) => alias.length >= 2)
    .some((alias) => sourceNames.some((name) => name === alias || name.includes(alias)));
}

function providerRuns(state) {
  return asArray(state.runs).flatMap((run) => asArray(run.providerRuns).map((providerRun) => ({
    ...providerRun,
    registryRunId: run.id || null,
  })));
}

function liveProviderRuns(state, requirement) {
  if (!requirement?.provider) return [];
  return providerRuns(state).filter((run) => {
    if (run.provider !== requirement.provider || run.status !== "ok") return false;
    if (Number(requirement.minimumRequestCount || 0) > Number(run.metadata?.requestCount || 0)) return false;
    if (Number(requirement.minimumHits || 0) > Number(run.hits || 0)) return false;
    return asArray(requirement.requiredMetadataFields).every((field) => Boolean(run.metadata?.[field]));
  });
}

function buildTargetCoverage(state, channelPlan) {
  const sources = asArray(state.sources);
  return channelPlan.targetInventory.employers.map((target) => {
    const matched = sources.filter((source) => sourceMatchesTarget(source, target));
    const approved = matched.filter(sourceIsApproved);
    const verified = matched.filter((source) => source.verificationState === "verified");
    const stateName = approved.length ? "covered"
      : verified.length ? "awaiting_approval"
        : matched.length ? "discovered"
          : "missing";
    return {
      id: target.id,
      name: target.name,
      segment: target.segment,
      desiredChannelIds: target.desiredChannelIds,
      officialRecruitmentUrl: target.audit.officialRecruitmentUrl,
      state: stateName,
      matchedSourceIds: matched.map((source) => source.id).sort(),
      approvedSourceIds: approved.map((source) => source.id).sort(),
      gapReasons: stateName === "covered" ? [] : [
        stateName === "awaiting_approval" ? "VERIFIED_TARGET_NOT_APPROVED"
          : stateName === "discovered" ? "TARGET_NOT_VERIFIED"
            : "TARGET_NOT_DISCOVERED",
      ],
    };
  });
}

function buildChannelCoverage(state, queryPlan, channelPlan, targets) {
  const sources = asArray(state.sources);
  const bucketIds = new Set(asArray(queryPlan.buckets).map((bucket) => bucket.id));
  const tasks = expandQueryPlan(queryPlan);
  return channelPlan.channels.map((channel) => {
    const matched = sources.filter((source) => sourceMatchesChannel(source, channel));
    const approved = matched.filter(sourceIsApproved);
    const missingQueryBucketIds = asArray(channel.requiredQueryBucketIds).filter((id) => !bucketIds.has(id));
    const queryTasks = asArray(channel.requiredQueryProviders).length
      ? tasks.filter((task) => task.providers.some((provider) => channel.requiredQueryProviders.includes(provider)))
      : tasks.filter((task) => asArray(channel.requiredQueryBucketIds).includes(task.bucketId));
    const liveRuns = liveProviderRuns(state, channel.providerRunEvidence);
    const channelTargets = targets.filter((target) => target.desiredChannelIds.includes(channel.id));
    const approvedSourceIds = new Set(approved.map((source) => source.id));
    const coveredTargets = channelTargets.filter((target) => target.approvedSourceIds.some((sourceId) => approvedSourceIds.has(sourceId)));
    const coveredTargetIds = new Set(coveredTargets.map((target) => target.id));
    const hardGapReasons = [];
    if (missingQueryBucketIds.length) hardGapReasons.push("MISSING_QUERY_BUCKET");
    if (asArray(channel.requiredQueryProviders).length && queryTasks.length === 0) hardGapReasons.push("NO_CAPABLE_QUERY_TASK");
    if (channel.providerRunEvidence && liveRuns.length === 0) hardGapReasons.push("NO_LIVE_PROVIDER_EVIDENCE");
    if (channel.directlyProducesJobs && approved.length === 0) hardGapReasons.push("NO_APPROVED_SOURCE");
    if (channel.targetCoverage?.mode === "required_all" && channelTargets.length && coveredTargets.length < channelTargets.length) hardGapReasons.push("EMPLOYER_TARGET_GAPS");
    const onDemand = channel.requiredForOperationalCoverage === false;
    const stateName = onDemand ? (matched.length ? "observed_on_demand" : "on_demand_unobserved")
      : hardGapReasons.length ? "gap"
        : "covered";
    return {
      id: channel.id,
      label: channel.label,
      role: channel.role,
      cadence: channel.cadence,
      directlyProducesJobs: channel.directlyProducesJobs,
      requiredForOperationalCoverage: channel.requiredForOperationalCoverage,
      state: stateName,
      hasGap: !onDemand && stateName !== "covered",
      matchedSourceIds: matched.map((source) => source.id).sort(),
      approvedSourceIds: approved.map((source) => source.id).sort(),
      requiredQueryBucketIds: asArray(channel.requiredQueryBucketIds),
      missingQueryBucketIds,
      plannedQueryTasks: queryTasks.length,
      liveProviderRunIds: liveRuns.map((run) => run.registryRunId).filter(Boolean).sort(),
      targetCoverage: {
        mode: channel.targetCoverage?.mode || "informational",
        planned: channelTargets.length,
        covered: coveredTargets.length,
        missingTargetIds: channelTargets.filter((target) => !coveredTargetIds.has(target.id)).map((target) => target.id),
      },
      gapReasons: hardGapReasons,
    };
  });
}

function addToMapSet(map, key, value) {
  if (!key) return;
  const values = map.get(key) || new Set();
  values.add(value);
  map.set(key, values);
}

function buildRegionCoverage(state, queryPlan, channelPlan, channels) {
  const regionPlan = channelPlan.regionCoverage || {};
  const directChannelIds = new Set(asArray(regionPlan.sourceChannelIds));
  const approvedDirectSourceIds = new Set(channels
    .filter((channel) => directChannelIds.has(channel.id))
    .flatMap((channel) => channel.approvedSourceIds));
  const sourceProvince = new Map();
  const sourceCity = new Map();
  for (const source of asArray(state.sources)) {
    if (!approvedDirectSourceIds.has(source.id)) continue;
    for (const region of asArray(sourceCandidate(source).regions)) {
      addToMapSet(sourceProvince, region?.provinceCode, source.id);
      addToMapSet(sourceCity, region?.cityCode, source.id);
    }
  }
  for (const edge of asArray(state.edges)) {
    if (!approvedDirectSourceIds.has(edge.from) || edge.type !== "covers_region" || edge.verificationState !== "verified") continue;
    const evidenceKind = edge.verifiedEvidence?.kind || edge.evidence?.kind;
    if (evidenceKind === "collected_job_region") continue;
    const match = String(edge.to || "").match(/^region:(CN|\d{6}):(ALL|\d{6})$/);
    if (!match) continue;
    if (match[1] !== "CN") addToMapSet(sourceProvince, match[1], edge.from);
    if (match[2] !== "ALL") addToMapSet(sourceCity, match[2], edge.from);
  }

  const jobProvince = new Map();
  const jobCity = new Map();
  const coverageAsOf = new Date(state.metadata?.updatedAt || Date.now());
  for (const job of asArray(state.jobs)) {
    const validThrough = job.validThrough ? new Date(job.validThrough) : null;
    if (["closed", "quarantined"].includes(job.status) || validThrough && !Number.isNaN(validThrough.getTime()) && validThrough < coverageAsOf) continue;
    const supported = asArray(job.sourceIds).length ? job.sourceIds : [job.sourceId];
    const approvedSupport = supported.filter((sourceId) => approvedDirectSourceIds.has(sourceId));
    if (!approvedSupport.length) continue;
    for (const region of asArray(job.workLocations || job.regions)) {
      addToMapSet(jobProvince, region?.provinceCode, job.id);
      addToMapSet(jobCity, region?.cityCode, job.id);
      for (const sourceId of approvedSupport) {
        addToMapSet(sourceProvince, region?.provinceCode, sourceId);
        addToMapSet(sourceCity, region?.cityCode, sourceId);
      }
    }
  }

  const regions = listChinaRegions();
  const provinceByName = new Map();
  const cityByName = new Map();
  for (const province of regions) {
    for (const value of [province.label, province.provinceName]) provinceByName.set(regionNameKey(value), province.provinceCode);
    for (const city of province.cities) {
      for (const value of [city.label, city.cityName]) cityByName.set(regionNameKey(value), city.cityCode);
    }
  }
  const queryProvince = new Map();
  const queryCity = new Map();
  for (const task of expandQueryPlan(queryPlan)) {
    const provinceCode = provinceByName.get(regionNameKey(task.dimensions?.[regionPlan.queryDimensions?.province || "province"]));
    const cityCode = cityByName.get(regionNameKey(task.dimensions?.[regionPlan.queryDimensions?.secondLevel || "city"]));
    addToMapSet(queryProvince, provinceCode, task.id);
    addToMapSet(queryCity, cityCode, task.id);
  }

  const provinces = regions.map((province) => ({
    provinceCode: province.provinceCode,
    label: province.label,
    queryPlanned: Boolean(queryProvince.get(province.provinceCode)?.size),
    queryTaskCount: queryProvince.get(province.provinceCode)?.size || 0,
    approvedSourceIds: [...(sourceProvince.get(province.provinceCode) || [])].sort(),
    approvedSourceCount: sourceProvince.get(province.provinceCode)?.size || 0,
    observedJobCount: jobProvince.get(province.provinceCode)?.size || 0,
    gaps: {
      query: !queryProvince.get(province.provinceCode)?.size,
      approvedSource: !sourceProvince.get(province.provinceCode)?.size,
      observedJob: !jobProvince.get(province.provinceCode)?.size,
    },
  }));
  const secondLevel = regions.flatMap((province) => province.cities.map((city) => ({
    provinceCode: province.provinceCode,
    cityCode: city.cityCode,
    label: city.label,
    queryPlanned: Boolean(queryCity.get(city.cityCode)?.size),
    queryTaskCount: queryCity.get(city.cityCode)?.size || 0,
    approvedSourceIds: [...(sourceCity.get(city.cityCode) || [])].sort(),
    approvedSourceCount: sourceCity.get(city.cityCode)?.size || 0,
    observedJobCount: jobCity.get(city.cityCode)?.size || 0,
    gaps: {
      query: !queryCity.get(city.cityCode)?.size,
      approvedSource: !sourceCity.get(city.cityCode)?.size,
      observedJob: !jobCity.get(city.cityCode)?.size,
    },
  })));
  return { provinces, secondLevel };
}

export function computeSourceCoverage({ registry, queryPlan, channelPlan }) {
  if (!registry || !Array.isArray(registry.sources) || !Array.isArray(registry.jobs) || !Array.isArray(registry.runs)) {
    throw new TypeError("来源覆盖计算需要包含 sources、jobs、runs 的 Registry 快照");
  }
  validateSourceChannelPlan(channelPlan);
  const targets = buildTargetCoverage(registry, channelPlan);
  const channels = buildChannelCoverage(registry, queryPlan, channelPlan, targets);
  const regions = buildRegionCoverage(registry, queryPlan, channelPlan, channels);
  const requiredChannels = channels.filter((channel) => channel.requiredForOperationalCoverage);
  const coveredTargets = targets.filter((target) => target.state === "covered");
  const provinceSourceCovered = regions.provinces.filter((region) => !region.gaps.approvedSource);
  const citySourceCovered = regions.secondLevel.filter((region) => !region.gaps.approvedSource);
  return {
    schemaVersion: SOURCE_COVERAGE_SCHEMA_VERSION,
    asOf: registry.metadata?.updatedAt || null,
    registryRevision: Number(registry.revision || 0),
    planVersion: channelPlan.metadata?.version || null,
    definition: channelPlan.metadata?.definition || null,
    nonExhaustive: channelPlan.metadata?.nonExhaustive === true,
    summary: {
      channelsPlanned: channels.length,
      channelsOperationallyRequired: requiredChannels.length,
      channelsCovered: requiredChannels.filter((channel) => channel.state === "covered").length,
      channelsWithGaps: requiredChannels.filter((channel) => channel.hasGap).length,
      employerTargetsPlanned: targets.length,
      employerTargetsCovered: coveredTargets.length,
      provincesPlanned: regions.provinces.length,
      provincesWithQueryTask: regions.provinces.filter((region) => region.queryPlanned).length,
      provincesWithApprovedSource: provinceSourceCovered.length,
      secondLevelPlanned: regions.secondLevel.length,
      secondLevelWithQueryTask: regions.secondLevel.filter((region) => region.queryPlanned).length,
      secondLevelWithApprovedSource: citySourceCovered.length,
    },
    channels,
    targets,
    regions,
    gaps: {
      channels: channels.filter((channel) => channel.hasGap).map((channel) => channel.id),
      targets: targets.filter((target) => target.state !== "covered").map((target) => target.id),
      regions: {
        provinceQuery: regions.provinces.filter((region) => region.gaps.query).map((region) => region.provinceCode),
        provinceSource: regions.provinces.filter((region) => region.gaps.approvedSource).map((region) => region.provinceCode),
        provinceJobs: regions.provinces.filter((region) => region.gaps.observedJob).map((region) => region.provinceCode),
        secondLevelQuery: regions.secondLevel.filter((region) => region.gaps.query).map((region) => region.cityCode),
        secondLevelSource: regions.secondLevel.filter((region) => region.gaps.approvedSource).map((region) => region.cityCode),
        secondLevelJobs: regions.secondLevel.filter((region) => region.gaps.observedJob).map((region) => region.cityCode),
      },
    },
    limitations: [
      "该报告只对版本化渠道、重点企业和行政区划分母计算缺口，不声称覆盖全部互联网或全部中国企业。",
      "全国来源不会自动填满省市覆盖；地域覆盖只读取明确来源地域、结构化岗位地点和查询维度。",
      "发现渠道的成功记录不等于候选来源已验证或已获采集批准。",
    ],
  };
}

export async function analyzeSourceCoverage({
  projectRoot = defaultProjectRoot,
  registry = null,
  registryPath = resolve(projectRoot, ".huangque/state.json"),
  queryPlan = null,
  queryPlanPath = resolve(projectRoot, "data/huangque/national-query-plan.json"),
  channelPlan = null,
  channelPlanPath = resolve(projectRoot, "data/huangque/source-channel-plan.json"),
} = {}) {
  const [effectiveRegistry, effectiveQueryPlan, effectiveChannelPlan] = await Promise.all([
    registry && typeof registry.snapshot === "function" ? registry.snapshot()
      : registry || readJson(registryPath, "Registry"),
    queryPlan || readJson(queryPlanPath, "全国查询计划"),
    channelPlan || loadSourceChannelPlan(channelPlanPath),
  ]);
  return computeSourceCoverage({
    registry: effectiveRegistry,
    queryPlan: effectiveQueryPlan,
    channelPlan: effectiveChannelPlan,
  });
}
