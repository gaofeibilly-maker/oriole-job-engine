import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyzeSourceCoverage,
  computeSourceCoverage,
  loadSourceChannelPlan,
  validateSourceChannelPlan,
} from "../scripts/huangque/lib/source-coverage.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadQueryPlan() {
  return JSON.parse(await readFile(resolve(projectRoot, "data/huangque/national-query-plan.json"), "utf8"));
}

function approvedSource({ id, sourceType, sourceRootUrl, provider = null, publisher = null, regions = [], evidence = [], probe = null }) {
  return {
    id,
    name: publisher || id,
    lifecycle: "approved",
    reviewStatus: "approved",
    verificationState: "verified",
    collectionEnabled: true,
    candidate: {
      id,
      sourceKey: `fixture:${id}`,
      name: publisher || id,
      sourceType,
      sourceRootUrl,
      provider,
      publisher,
      regions,
      evidence,
    },
    probe: probe || { verificationState: "verified", strategy: "fixture", evidence: [] },
  };
}

function fixtureRegistry() {
  const wuhan = { countryCode: "CN", provinceCode: "420000", provinceName: "湖北省", cityCode: "420100", cityName: "武汉市", label: "湖北省-武汉市" };
  const shanghai = { countryCode: "CN", provinceCode: "310000", provinceName: "上海市", cityCode: null, cityName: null, label: "上海" };
  const hangzhou = { countryCode: "CN", provinceCode: "330000", provinceName: "浙江省", cityCode: "330100", cityName: "杭州市", label: "浙江省-杭州市" };
  const bytedance = approvedSource({
    id: "company-bytedance",
    sourceType: "company_career_site",
    sourceRootUrl: "https://jobs.bytedance.com/experienced/position",
    publisher: "字节跳动",
    regions: [wuhan],
    evidence: [{ channel: "baidu", url: "https://jobs.bytedance.com/" }],
  });
  const lever = approvedSource({
    id: "ats-example",
    sourceType: "official_ats",
    sourceRootUrl: "https://jobs.lever.co/example",
    provider: "Lever",
    publisher: "Example Employer",
    regions: [shanghai],
  });
  const government = approvedSource({
    id: "government-wuhan",
    sourceType: "government_public_employment",
    sourceRootUrl: "https://jobs.wuhan.gov.cn/public",
    publisher: "武汉公共就业服务",
    regions: [wuhan],
    evidence: [{ channel: "official_catalog", url: "https://jobs.wuhan.gov.cn/public" }],
  });
  const feed = approvedSource({
    id: "feed-hangzhou",
    sourceType: "company_career_site",
    sourceRootUrl: "https://careers.example.cn/jobs",
    publisher: "杭州示例企业",
    regions: [hangzhou],
    probe: { verificationState: "verified", strategy: "xml_feed_or_sitemap", collectionEndpoint: "https://careers.example.cn/jobs.xml", evidence: [] },
  });
  const tencent = {
    id: "candidate-tencent",
    name: "腾讯招聘",
    lifecycle: "probed",
    reviewStatus: "pending",
    verificationState: "verified",
    collectionEnabled: false,
    candidate: {
      id: "candidate-tencent",
      sourceKey: "fixture:tencent",
      name: "腾讯招聘",
      sourceType: "company_career_site",
      sourceRootUrl: "https://careers.tencent.com/",
      publisher: "腾讯",
      regions: [],
      evidence: [{ channel: "baidu", url: "https://careers.tencent.com/" }],
    },
    probe: { verificationState: "verified", strategy: "html_listing" },
  };
  const submitted = {
    id: "submitted-park",
    name: "用户提交园区",
    lifecycle: "candidate",
    reviewStatus: "unreviewed",
    verificationState: "unverified_candidate",
    collectionEnabled: false,
    candidate: {
      id: "submitted-park",
      sourceKey: "fixture:submitted-park",
      name: "用户提交园区",
      sourceType: "park_or_association_board",
      sourceRootUrl: "https://park.example.cn/jobs",
      regions: [],
      evidence: [{ channel: "user_submission", url: "https://park.example.cn/jobs" }],
    },
  };
  return {
    schemaVersion: "huangque.registry.v1",
    revision: 7,
    metadata: { project: "黄雀", updatedAt: "2026-08-20T12:00:00.000Z" },
    bucketState: {},
    sources: [bytedance, lever, government, feed, tencent, submitted],
    edges: [],
    runs: [{
      id: "run-discovery-live",
      providerRuns: [
        { provider: "baidu", status: "ok", hits: 2, warnings: [], metadata: { requestCount: 1 } },
        { provider: "common_crawl", status: "failed", hits: 0, warnings: ["fixture"], metadata: {} },
        { provider: "official_catalog", status: "ok", hits: 7, warnings: [], metadata: {} },
      ],
    }],
    jobs: [{
      id: "job-bytedance-wuhan",
      sourceId: bytedance.id,
      sourceIds: [bytedance.id],
      status: "confirmed_active",
      workLocations: [wuhan],
    }],
    events: [],
  };
}

test("source channel plan is explicitly bounded, auditable and covers nine channel classes", async () => {
  const plan = await loadSourceChannelPlan();
  assert.equal(plan.channels.length, 9);
  assert.equal(new Set(plan.channels.map((channel) => channel.id)).size, 9);
  assert.deepEqual(plan.channels.map((channel) => channel.id).sort(), [
    "company_career_sites",
    "public_ats",
    "government_public_employment",
    "campus_parks_associations",
    "baidu_search_api",
    "common_crawl_index",
    "official_public_directories",
    "sitemap_rss_feeds",
    "user_submissions",
  ].sort());
  assert.equal(plan.metadata.nonExhaustive, true);
  assert.match(plan.targetInventory.scopeStatement, /不是企业排名|不宣称/);
  assert.ok(plan.channels.every((channel) => channel.objective && channel.cadence?.mode && typeof channel.directlyProducesJobs === "boolean"));
  const segments = new Set(plan.targetInventory.employers.map((target) => target.segment));
  assert.deepEqual([...segments].sort(), ["central_state_owned", "internet", "manufacturing", "technology"]);
  assert.equal(plan.targetInventory.employers.length, 19);
  assert.ok(plan.targetInventory.employers.every((target) => new URL(target.audit.officialRecruitmentUrl).protocol === "https:"));
  assert.throws(
    () => validateSourceChannelPlan({ ...plan, channels: plan.channels.slice(0, 8) }),
    /恰好声明 9 类渠道/,
  );
  assert.throws(
    () => validateSourceChannelPlan({ ...plan, channels: plan.channels.map((channel, index) => index ? channel : { ...channel, requiredForOperationalCoverage: undefined }) }),
    /requiredForOperationalCoverage/,
  );
});

test("coverage report separates channel, bounded employer and nationwide region gaps", async () => {
  const [channelPlan, queryPlan] = await Promise.all([loadSourceChannelPlan(), loadQueryPlan()]);
  const report = computeSourceCoverage({ registry: fixtureRegistry(), queryPlan, channelPlan });
  assert.equal(report.schemaVersion, "huangque.source-coverage.v1");
  assert.equal(report.nonExhaustive, true);
  assert.equal(report.summary.channelsPlanned, 9);
  assert.equal(report.summary.employerTargetsPlanned, 19);
  assert.equal(report.summary.provincesPlanned, 34);
  assert.equal(report.summary.secondLevelPlanned, 365);

  const channel = (id) => report.channels.find((item) => item.id === id);
  assert.equal(channel("company_career_sites").state, "gap");
  assert.deepEqual(channel("company_career_sites").approvedSourceIds, ["ats-example", "company-bytedance", "feed-hangzhou"]);
  assert.equal(channel("public_ats").state, "covered");
  assert.equal(channel("company_career_sites").targetCoverage.covered, 1);
  assert.equal(channel("public_ats").targetCoverage.covered, 0);
  assert.ok(channel("company_career_sites").gapReasons.includes("EMPLOYER_TARGET_GAPS"));
  assert.equal(channel("company_career_sites").targetCoverage.covered + channel("company_career_sites").targetCoverage.missingTargetIds.length, channel("company_career_sites").targetCoverage.planned);
  assert.equal(channel("government_public_employment").state, "covered");
  assert.equal(channel("campus_parks_associations").state, "gap");
  assert.ok(channel("campus_parks_associations").gapReasons.includes("NO_APPROVED_SOURCE"));
  assert.equal(channel("baidu_search_api").state, "covered");
  assert.equal(channel("common_crawl_index").state, "gap");
  assert.ok(channel("common_crawl_index").gapReasons.includes("NO_LIVE_PROVIDER_EVIDENCE"));
  assert.equal(channel("official_public_directories").state, "covered");
  assert.equal(channel("sitemap_rss_feeds").state, "covered");
  assert.equal(channel("user_submissions").state, "observed_on_demand");
  assert.equal(channel("user_submissions").hasGap, false);

  const target = (id) => report.targets.find((item) => item.id === id);
  assert.equal(target("bytedance").state, "covered");
  assert.deepEqual(target("bytedance").approvedSourceIds, ["company-bytedance"]);
  assert.equal(target("tencent").state, "awaiting_approval");
  assert.equal(target("byd").state, "missing");
  assert.ok(report.gaps.targets.includes("tencent"));
  assert.ok(report.gaps.targets.includes("byd"));

  const hubei = report.regions.provinces.find((region) => region.provinceCode === "420000");
  const wuhan = report.regions.secondLevel.find((region) => region.cityCode === "420100");
  const jingmen = report.regions.secondLevel.find((region) => region.cityCode === "420800");
  assert.equal(hubei.queryPlanned, true);
  assert.equal(hubei.approvedSourceCount, 2);
  assert.equal(hubei.observedJobCount, 1);
  assert.equal(wuhan.queryPlanned, true);
  assert.deepEqual(wuhan.approvedSourceIds, ["company-bytedance", "government-wuhan"]);
  assert.equal(wuhan.observedJobCount, 1);
  assert.equal(jingmen.queryPlanned, true);
  assert.equal(jingmen.approvedSourceCount, 0);
  assert.equal(jingmen.observedJobCount, 0);
  assert.ok(!report.gaps.regions.secondLevelQuery.includes("420800"));
  assert.ok(report.gaps.regions.secondLevelSource.includes("420800"));
  assert.ok(report.gaps.regions.secondLevelJobs.includes("420800"));
  assert.deepEqual(report, computeSourceCoverage({ registry: fixtureRegistry(), queryPlan, channelPlan }));
});

test("active job locations backfill source coverage while closed jobs do not", async () => {
  const [channelPlan, queryPlan] = await Promise.all([loadSourceChannelPlan(), loadQueryPlan()]);
  const registry = fixtureRegistry();
  registry.sources.find((source) => source.id === "company-bytedance").candidate.regions = [];
  let report = computeSourceCoverage({ registry, queryPlan, channelPlan });
  let wuhan = report.regions.secondLevel.find((region) => region.cityCode === "420100");
  assert.ok(wuhan.approvedSourceIds.includes("company-bytedance"));
  assert.equal(wuhan.observedJobCount, 1);

  registry.jobs[0].status = "closed";
  report = computeSourceCoverage({ registry, queryPlan, channelPlan });
  wuhan = report.regions.secondLevel.find((region) => region.cityCode === "420100");
  assert.ok(!wuhan.approvedSourceIds.includes("company-bytedance"));
  assert.equal(wuhan.observedJobCount, 0);
});

test("analyzeSourceCoverage reads Registry and both plans from explicit paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-coverage-"));
  const registryPath = join(directory, "state.json");
  const queryPlanPath = join(directory, "query-plan.json");
  const channelPlanPath = join(directory, "channel-plan.json");
  const [queryPlan, channelPlan] = await Promise.all([loadQueryPlan(), loadSourceChannelPlan()]);
  await Promise.all([
    writeFile(registryPath, JSON.stringify(fixtureRegistry()), "utf8"),
    writeFile(queryPlanPath, JSON.stringify(queryPlan), "utf8"),
    writeFile(channelPlanPath, JSON.stringify(channelPlan), "utf8"),
  ]);
  const report = await analyzeSourceCoverage({ registryPath, queryPlanPath, channelPlanPath });
  assert.equal(report.registryRevision, 7);
  assert.equal(report.asOf, "2026-08-20T12:00:00.000Z");
  assert.equal(report.summary.channelsPlanned, 9);
});
