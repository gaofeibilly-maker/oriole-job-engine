import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  EMPLOYER_UNIVERSE_MINIMUM_TARGETS,
  loadEmployerUniverse,
  refreshEmployerUniverse,
  validateEmployerUniverse,
} from "../scripts/huangque/lib/employer-universe.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const observedAt = "2026-08-21T04:17:00.000Z";

function sseRows(count, stockType, prefix, startCode) {
  return Array.from({ length: count }, (_, index) => {
    const code = String(startCode + index).padStart(6, "0");
    return {
      STOCK_TYPE: stockType,
      A_STOCK_CODE: code,
      COMPANY_ABBR: `${prefix}${index + 1}`,
      SEC_NAME_CN: `${prefix}${index + 1}`,
      FULL_NAME: `${prefix}${String(index + 1).padStart(4, "0")}股份有限公司`,
      AREA_NAME: index % 2 ? "110000" : "310000",
      CSRC_CODE_DESC: index % 2 ? "制造业" : "信息传输、软件和信息技术服务业",
      LIST_DATE: "20200101",
    };
  });
}

function ssePayload(count, stockType, prefix, startCode) {
  return JSON.stringify({
    sqlId: "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L",
    actionErrors: [],
    queryDate: "20260821",
    pageHelp: {
      pageNo: 1,
      pageCount: 1,
      total: count,
      data: sseRows(count, stockType, prefix, startCode),
    },
  });
}

function szseRows(count = 2_800) {
  return Array.from({ length: count }, (_, index) => {
    const code = String(index + 1).padStart(6, "0");
    return {
      code,
      pinyin: `sz${index + 1}`,
      category: "A股",
      orgId: `fixture-sz-${code}`,
      zwjc: `深证测试${String(index + 1).padStart(4, "0")}`,
    };
  });
}

function sasacHtml(count = 95) {
  const rows = Array.from({ length: count }, (_, index) => `<li>${index + 1} 测试央企${String(index + 1).padStart(3, "0")}集团有限公司</li>`).join("\n");
  return `<!doctype html><html><body><p>央企名录</p><p>发布时间：2026-07-11</p><ol>${rows}</ol></body></html>`;
}

function fixtureFetch({
  sasacFailure = false,
  failSseMain = false,
  sseMainCount = 1_600,
  sseStarCount = 550,
  szseCount = 2_800,
} = {}) {
  const rows = szseRows(szseCount);
  const otherMarketRows = Array.from({ length: 2_300 }, (_, index) => ({
    code: String(600_000 + index),
    pinyin: `sh${index + 1}`,
    category: "A股",
    orgId: `fixture-sh-${index + 1}`,
    zwjc: `沪市目录测试${index + 1}`,
  }));
  const requests = [];
  const fetchImpl = async (value) => {
    const url = new URL(value);
    requests.push(url.toString());
    assert.equal(url.protocol, "https:");
    assert.ok(["query.sse.com.cn", "www.cninfo.com.cn", "www.sasac.gov.cn"].includes(url.hostname));
    if (url.hostname === "query.sse.com.cn") {
      const stockType = url.searchParams.get("STOCK_TYPE");
      if (stockType === "1" && failSseMain) return new Response("upstream failed", { status: 503, headers: { "content-type": "text/plain" } });
      const body = stockType === "1"
        ? ssePayload(sseMainCount, "1", "上交主板测试", 600_000)
        : ssePayload(sseStarCount, "8", "科创测试", 688_000);
      return new Response(body, { status: 200, headers: { "content-type": "application/json;charset=UTF-8" } });
    }
    if (url.hostname === "www.cninfo.com.cn") {
      return new Response(JSON.stringify({ stockList: [...rows, ...otherMarketRows] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (sasacFailure) throw Object.assign(new Error("fixture network unavailable"), { code: "FIXTURE_UNAVAILABLE" });
    return new Response(sasacHtml(), { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
  };
  return { fetchImpl, requests };
}

let liveFixturePromise;
function liveFixture() {
  liveFixturePromise ||= refreshEmployerUniverse({
    outputPath: null,
    fetchImpl: fixtureFetch().fetchImpl,
    now: new Date(observedAt),
  });
  return liveFixturePromise;
}

test("injected official-directory responses build a deterministic 5000+ target universe", async () => {
  const fixture = fixtureFetch();
  const payload = await refreshEmployerUniverse({
    outputPath: null,
    fetchImpl: fixture.fetchImpl,
    now: new Date(observedAt),
  });
  assert.equal(payload.stats.rawRecords, 5_064);
  assert.equal(payload.stats.totalTargets, 5_064);
  assert.ok(payload.stats.totalTargets >= EMPLOYER_UNIVERSE_MINIMUM_TARGETS);
  assert.deepEqual(payload.stats.sourceRecords, {
    "curated-priority-employers": 19,
    "sasac-central-enterprises": 95,
    "sse-main-a": 1_600,
    "sse-star-a": 550,
    "szse-a": 2_800,
  });
  assert.equal(payload.metadata.allSourcesLive, false);
  assert.equal(payload.metadata.allOfficialSourcesLive, true);
  assert.equal(payload.metadata.complete, true);
  assert.deepEqual(payload.metadata.dataModes, ["curated_snapshot", "live"]);
  assert.equal(payload.stats.curatedSourceRecords, 19);
  assert.ok(payload.targets.every((target) => [
    "id", "name", "tier", "kind", "industry", "regionCode", "officialWebsite", "officialRecruitmentUrl", "officialDomains", "evidence",
  ].every((key) => Object.hasOwn(target, key))));
  assert.ok(payload.targets.every((target) => target.evidence.every((evidence) => evidence.url.startsWith("https://") && evidence.observedAt === observedAt)));
  assert.ok(fixture.requests.length >= 4);
  assert.ok(fixture.requests.every((url) => !/localhost|127\.0\.0\.1|example\.com/.test(url)));
  const bytedance = payload.targets.find((target) => target.identifiers.some((identifier) => identifier.value === "priority:bytedance"));
  assert.equal(bytedance?.name, "字节跳动");
  assert.equal(bytedance?.tier, "A");
  assert.equal(bytedance?.officialRecruitmentUrl, "https://jobs.bytedance.com/");
  assert.deepEqual(bytedance?.officialDomains, ["jobs.bytedance.com"]);
  assert.equal(bytedance?.evidence[0].sourceMode, "curated_snapshot");

  const again = await refreshEmployerUniverse({
    outputPath: null,
    fetchImpl: fixtureFetch().fetchImpl,
    now: new Date("2026-08-22T04:17:00.000Z"),
  });
  assert.deepEqual(again.targets.map((target) => target.id), payload.targets.map((target) => target.id));
});

test("SASAC network failure is explicitly labelled snapshot and never reported as all-live", async () => {
  const payload = await refreshEmployerUniverse({
    outputPath: null,
    fetchImpl: fixtureFetch({ sasacFailure: true }).fetchImpl,
    now: new Date(observedAt),
  });
  const sasac = payload.sources.find((source) => source.id === "sasac-central-enterprises");
  assert.equal(sasac.mode, "snapshot");
  assert.equal(sasac.snapshotAsOf, "2026-07-11");
  assert.equal(sasac.records, 99);
  assert.equal(sasac.liveAttempt.status, "failed");
  assert.equal(payload.metadata.allSourcesLive, false);
  assert.equal(payload.metadata.allOfficialSourcesLive, false);
  assert.deepEqual(payload.metadata.dataModes, ["curated_snapshot", "live", "snapshot"]);
  assert.equal(payload.stats.snapshotSourceRecords, 99);
  assert.ok(payload.targets.flatMap((target) => target.evidence)
    .filter((evidence) => evidence.sourceId === "sasac-central-enterprises")
    .every((evidence) => evidence.sourceMode === "snapshot"));
});

test("strict validation rejects a shrunken universe and evidence mode laundering", async () => {
  const complete = structuredClone(await liveFixture());
  complete.targets = complete.targets.slice(0, 4_999);
  assert.throws(() => validateEmployerUniverse(complete), /至少需要 5000/);

  const wrongMode = structuredClone(await liveFixture());
  wrongMode.targets[0].evidence[0].sourceMode = "snapshot";
  assert.throws(() => validateEmployerUniverse(wrongMode), /错标模式/);

  const incompleteMetadata = structuredClone(await liveFixture());
  incompleteMetadata.metadata.complete = false;
  assert.throws(() => validateEmployerUniverse(incompleteMetadata), /有界覆盖声明/);
});

test("a source count below its audited floor fails before any snapshot can be written", async () => {
  await assert.rejects(
    () => refreshEmployerUniverse({
      outputPath: null,
      fetchImpl: fixtureFetch({ sseMainCount: 1_599 }).fetchImpl,
      now: new Date(observedAt),
    }),
    (error) => error.code === "DIRECTORY_RECORD_COUNT_OUT_OF_RANGE" && error.sourceId === "sse-main-a",
  );
  await assert.rejects(
    () => refreshEmployerUniverse({
      outputPath: null,
      fetchImpl: fixtureFetch({ sseStarCount: 349 }).fetchImpl,
      now: new Date(observedAt),
    }),
    (error) => error.code === "DIRECTORY_RECORD_COUNT_OUT_OF_RANGE" && error.sourceId === "sse-star-a",
  );
});

test("failed refresh does not overwrite the last complete atomic snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-employer-universe-"));
  const path = join(directory, "employer-universe.json");
  await refreshEmployerUniverse({
    outputPath: path,
    fetchImpl: fixtureFetch().fetchImpl,
    now: new Date(observedAt),
  });
  const before = await readFile(path, "utf8");
  await assert.rejects(() => refreshEmployerUniverse({
    outputPath: path,
    fetchImpl: fixtureFetch({ failSseMain: true }).fetchImpl,
    now: new Date("2026-08-22T04:17:00.000Z"),
  }), /HTTP 503/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await loadEmployerUniverse(path)).stats.totalTargets, 5_064);
});

test("the checked-in employer universe is complete, bounded and self-validating", async () => {
  const payload = await loadEmployerUniverse(resolve(projectRoot, "data/huangque/employer-universe.json"));
  assert.ok(payload.targets.length >= 5_000);
  assert.equal(payload.sources.length, 5);
  assert.equal(payload.stats.totalTargets, payload.targets.length);
  assert.equal(payload.metadata.completeness, "bounded_official_directory_universe");
  assert.equal(payload.metadata.complete, true);
  assert.ok(payload.targets.some((target) => target.identifiers.some((identifier) => identifier.value === "priority:bytedance")
    && target.officialRecruitmentUrl === "https://jobs.bytedance.com/"));
});
