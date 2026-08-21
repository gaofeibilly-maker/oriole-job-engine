import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChinaLocation, classifyChinaLocations, jobMatchesRegion, listChinaRegions } from "../scripts/huangque/lib/china-regions.mjs";
import { normalizeAdapterPayload } from "../scripts/huangque/lib/adapters.mjs";
import { buildBaiduRequest } from "../scripts/huangque/lib/providers.mjs";
import { JsonRegistry } from "../scripts/huangque/lib/registry.mjs";
import { HuangqueEngine } from "../scripts/huangque/lib/engine.mjs";

test("region taxonomy covers every province-level region and nationwide prefecture layer", () => {
  const regions = listChinaRegions();
  assert.equal(regions.length, 34);
  assert.equal(regions.reduce((total, province) => total + province.cities.length, 0), 365);
  assert.equal(regions.find((item) => item.provinceCode === "420000").cities.find((item) => item.cityCode === "420100").label, "湖北省-武汉市");
  assert.equal(regions.find((item) => item.provinceCode === "460000").cities.find((item) => item.cityCode === "469005").label, "海南省-文昌市");
});

test("municipalities, ordinary cities and autonomous regions normalize deterministically", () => {
  assert.equal(classifyChinaLocation("Beijing, China").regions[0].label, "北京");
  assert.equal(classifyChinaLocation("北京市海淀区").regions[0].label, "北京");
  assert.equal(classifyChinaLocation("Wuhan, Hubei, China").regions[0].label, "湖北省-武汉市");
  assert.equal(classifyChinaLocation("湖北省武汉市").regions[0].cityCode, "420100");
  assert.equal(classifyChinaLocation("上海市浦东新区").regions[0].label, "上海");
  assert.equal(classifyChinaLocation("南宁，广西壮族自治区").regions[0].label, "广西壮族自治区-南宁市");
  assert.equal(classifyChinaLocation("呼和浩特，内蒙古自治区").regions[0].label, "内蒙古自治区-呼和浩特市");
  assert.equal(classifyChinaLocation("Hainan, China").regions[0].label, "海南省");
  assert.equal(classifyChinaLocation("海南州，青海省").regions[0].label, "青海省-海南藏族自治州");
});

test("ambiguous English city names never invent two simultaneous work locations", () => {
  const ambiguous = classifyChinaLocation("Suzhou, China");
  assert.equal(ambiguous.regions[0].label, "中国-地点待核验");
  assert.deepEqual(ambiguous.ambiguousRegions.map((region) => region.label).sort(), ["安徽省-宿州市", "江苏省-苏州市"]);
  assert.equal(classifyChinaLocation("Suzhou, Jiangsu, China").regions[0].label, "江苏省-苏州市");
  assert.equal(classifyChinaLocation("Suzhou, Anhui, China").regions[0].label, "安徽省-宿州市");
});

test("multi-location and remote-China jobs preserve every China work location", () => {
  const multi = classifyChinaLocations("北京/广州/上海");
  assert.deepEqual(multi.regions.map((item) => item.label), ["北京", "广东省-广州市", "上海"]);
  assert.deepEqual(classifyChinaLocations(["China", "Shenzhen, China", "Guangdong"]).regions.map((item) => item.label), ["广东省-深圳市"]);
  assert.equal(classifyChinaLocation("Remote - China").regions[0].label, "全国-远程");
  assert.equal(classifyChinaLocation("Tokyo, Japan").status, "outside_china");
});

test("generic China location may use an explicit city in the job title but never description text", () => {
  const source = {
    id: "source-lever",
    sourceKey: "ats:lever:weride",
    name: "WeRide",
    candidate: { provider: "Lever", tenant: "weride", sourceType: "official_ats", sourceRootUrl: "https://jobs.lever.co/weride" },
  };
  const response = {
    body: JSON.stringify([{ id: "multi", text: "Engineer - Beijing/Guangzhou/Shanghai", categories: { location: "China" }, descriptionPlain: "The team also works with Tokyo", hostedUrl: "https://jobs.lever.co/weride/multi" }]),
    contentType: "application/json",
    finalUrl: "https://api.lever.co/v0/postings/weride?mode=json",
  };
  const job = normalizeAdapterPayload(source, response).jobs[0];
  assert.deepEqual(job.workLocations.map((item) => item.label), ["北京", "广东省-广州市", "上海"]);
  assert.equal(job.locationBasis, "job_title_location");
});

test("structured overseas location is not overridden by incidental China description text", () => {
  const source = {
    id: "source-ashby",
    sourceKey: "ats:ashby:global",
    name: "Global jobs",
    candidate: { provider: "Ashby", tenant: "global", sourceType: "official_ats", sourceRootUrl: "https://jobs.ashbyhq.com/global" },
  };
  const response = {
    body: JSON.stringify({ jobs: [{ id: "tokyo", title: "Engineer", location: "Tokyo, Japan", descriptionPlain: "Partner with the Beijing team", jobUrl: "https://jobs.ashbyhq.com/global/tokyo" }] }),
    contentType: "application/json",
    finalUrl: "https://api.ashbyhq.com/posting-api/job-board/global",
  };
  assert.equal(normalizeAdapterPayload(source, response).jobs.length, 0);
});

test("Ashby secondary China locations survive even when the primary location is overseas", () => {
  const source = {
    id: "source-ashby",
    sourceKey: "ats:ashby:global",
    name: "Global jobs",
    candidate: { provider: "Ashby", tenant: "global", sourceType: "official_ats", sourceRootUrl: "https://jobs.ashbyhq.com/global" },
  };
  const response = {
    body: JSON.stringify({ jobs: [{ id: "multi", title: "Engineer", location: "Tokyo, Japan", secondaryLocations: [{ location: "Beijing, China" }, { location: "Shenzhen, China" }], jobUrl: "https://jobs.ashbyhq.com/global/multi" }] }),
    contentType: "application/json",
    finalUrl: "https://api.ashbyhq.com/posting-api/job-board/global",
  };
  const job = normalizeAdapterPayload(source, response).jobs[0];
  assert.deepEqual(job.workLocations.map((item) => item.label), ["北京", "广东省-深圳市"]);
  assert.equal(job.location.includes("Tokyo"), false);
});

test("region filters and Baidu geo requests use the requested city, never a Beijing fallback", () => {
  const job = { workLocations: classifyChinaLocation("武汉").regions };
  assert.equal(jobMatchesRegion(job, { provinceCode: "420000", cityCode: "420100" }), true);
  assert.equal(jobMatchesRegion(job, { provinceCode: "110000" }), false);
  assert.deepEqual(buildBaiduRequest("武汉 招聘", { city: "武汉" }).search_filter.range.geo.city, ["武汉"]);
  assert.equal(Object.hasOwn(buildBaiduRequest("中国 招聘", { city: null }).search_filter.range, "geo"), false);
});

test("list_regions counts unique jobs across province, province-only and city aggregates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-region-counts-"));
  const engine = new HuangqueEngine({ projectRoot: directory });
  const wuhan = classifyChinaLocation("湖北省武汉市").regions[0];
  const yichang = classifyChinaLocation("湖北省宜昌市").regions[0];
  const hubei = classifyChinaLocation("湖北省").regions[0];
  await engine.registry.transaction((state) => {
    state.jobs.push(
      { id: "multi-city", workLocations: [wuhan, yichang] },
      { id: "province-only", workLocations: [hubei] },
    );
  });
  const result = await engine.listRegions({ provinceCode: "420000" });
  const province = result.regions[0];
  assert.equal(province.jobCount, 2);
  assert.equal(province.provinceOnlyJobCount, 1);
  assert.equal(province.cities.find((city) => city.cityCode === "420100").jobCount, 1);
  assert.equal(province.cities.find((city) => city.cityCode === "420500").jobCount, 1);
});

test("source graph persists publisher, region, entry, endpoint and discovery evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-graph-"));
  const registry = new JsonRegistry(join(directory, "state.json"), { now: () => new Date("2026-08-20T00:00:00.000Z") });
  const candidate = {
    id: "source-wuhan",
    sourceKey: "ats:lever:wuhan",
    name: "Wuhan Company · Lever",
    publisher: "Wuhan Company",
    tenant: "wuhan",
    provider: "Lever",
    entryUrl: "https://jobs.lever.co/wuhan",
    sourceRootUrl: "https://jobs.lever.co/wuhan",
    publicApiUrl: "https://api.lever.co/v0/postings/wuhan?mode=json",
    regions: classifyChinaLocation("武汉").regions,
    scopeSignals: ["湖北省-武汉市"],
    evidence: [{ channel: "baidu", queryId: "wuhan:1", query: "武汉 招聘", url: "https://jobs.lever.co/wuhan", providerEvidence: { requestId: "request-fixture" } }],
  };
  await registry.upsertCandidates({ candidates: [candidate] }, "run-fixture");
  const state = await registry.snapshot();
  assert.deepEqual(new Set(state.edges.map((edge) => edge.type)), new Set(["published_by", "covers_region", "has_entry_point", "has_endpoint", "discovered_via"]));
  assert.ok(state.edges.every((edge) => edge.evidence && Object.keys(edge.evidence).length > 0));
  assert.equal(state.edges.find((edge) => edge.type === "discovered_via").evidence.providerEvidence.requestId, "request-fixture");
});

test("existing nationwide snapshot bootstraps traceable jobs and lists_job graph edges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-snapshot-"));
  const snapshotPath = join(directory, "snapshot.json");
  const location = classifyChinaLocation("湖北省武汉市").regions;
  await writeFile(snapshotPath, JSON.stringify({
    metadata: { schemaVersion: "job-radar-data-v4", generatedAt: "2026-08-20T00:00:00.000Z" },
    sources: [{ id: "lever-wuhan", name: "Wuhan Company", provider: "Lever", kind: "official_ats", publicUrl: "https://jobs.lever.co/wuhan", jobs: 1, fetchedAt: "2026-08-20T00:00:00.000Z", fetchStatus: "ok" }],
    jobs: [{
      schemaVersion: "huangque.job.v2",
      id: "lever-wuhan-1",
      sourceId: "lever-wuhan",
      sourceName: "Wuhan Company",
      sourceUrl: "https://jobs.lever.co/wuhan/one",
      applyUrl: "https://jobs.lever.co/wuhan/one/apply",
      company: "Wuhan Company",
      title: "Engineer",
      location: "湖北省-武汉市",
      workLocations: location,
      regions: location,
      status: "confirmed_active",
      activeScore: 98,
      authenticityScore: 99,
      channelScore: 97,
      observedAt: "2026-08-20T00:00:00.000Z",
      evidence: ["官方 Lever 列表仍返回该岗位"],
    }],
  }));
  const engine = new HuangqueEngine({ projectRoot: directory, existingSnapshotPath: snapshotPath, now: () => new Date("2026-08-20T00:00:00.000Z") });
  const imported = await engine.bootstrapExistingSources();
  const jobs = await engine.listJobs({ provinceCode: "420000", cityCode: "420100" });
  const regions = await engine.listRegions({ provinceCode: "420000" });
  const graph = await engine.getSourceGraph({ relationType: "lists_job" });
  const publisherGraph = await engine.getSourceGraph({ relationType: "published_by" });
  assert.equal(imported.jobs.received, 1);
  assert.equal(jobs.total, 1);
  assert.equal(regions.regions[0].jobCount, jobs.total);
  assert.equal(regions.regions[0].provinceOnlyJobCount, 0);
  assert.equal(regions.regions[0].cities.find((city) => city.cityCode === "420100").jobCount, 1);
  assert.equal(jobs.jobs[0].contentHash.length, 64);
  assert.equal(graph.total, 1);
  assert.ok(graph.edges[0].evidence.contentHash);
  assert.deepEqual(publisherGraph.edges.map((edge) => edge.to), ["publisher:Wuhan Company"]);
});
