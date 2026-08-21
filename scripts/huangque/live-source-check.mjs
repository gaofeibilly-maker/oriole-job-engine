#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HuangqueEngine } from "./lib/engine.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = resolve(process.env.HUANGQUE_REGISTRY_PATH || `${projectRoot}/.huangque/live-source-state.json`);
const artifactRoot = resolve(process.env.HUANGQUE_ARTIFACT_ROOT || `${projectRoot}/.huangque/live-source-artifacts`);
const sourceId = process.env.HUANGQUE_LIVE_SOURCE_ID || "bytedance-official-careers";

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

async function main() {
  const engine = new HuangqueEngine({ projectRoot, registryPath, artifactRoot });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  const collection = await engine.collectJobs({ sourceId, commit: false });
  const result = collection.results[0];

  if (!result) fail("实时来源没有返回可审核的采集结果", "LIVE_SOURCE_EMPTY_RESULT");
  if (result.http?.status !== 200) fail("实时来源没有返回 HTTP 200", "LIVE_SOURCE_HTTP_FAILED");
  if (Number(result.parserStats?.observedRows || 0) < 1) fail("实时来源没有返回岗位行", "LIVE_SOURCE_NO_ROWS");
  if (Number(result.storage?.received || 0) < 1) fail("实时来源没有产生中国岗位", "LIVE_SOURCE_NO_CHINA_JOBS");
  if (!result.jobs.every((job) => job.applyUrl?.startsWith("https://jobs.bytedance.com/experienced/position/"))) {
    fail("实时来源产生了非官方申请链接", "LIVE_SOURCE_OWNERSHIP_FAILED");
  }

  const summary = {
    schemaVersion: "huangque.live-source-check.v1",
    checkedAt: result.fetchedAt,
    sourceId,
    officialPage: "https://jobs.bytedance.com/experienced/position",
    endpoint: result.endpoint,
    success: true,
    http: {
      status: result.http.status,
      finalUrl: result.http.finalUrl,
      pages: result.http.pages,
      bytes: result.http.bytes,
    },
    pagination: result.pagination,
    parser: result.parser,
    parserStats: result.parserStats,
    jobs: {
      chinaObserved: result.storage.received,
      officialApplyUrls: result.jobs.length,
      provinceCodes: [...new Set(result.jobs.flatMap((job) => job.workLocations || []).map((location) => location.provinceCode).filter(Boolean))].sort(),
      secondLevelCodes: [...new Set(result.jobs.flatMap((job) => job.workLocations || []).map((location) => location.cityCode).filter(Boolean))].sort(),
      sample: result.jobs.slice(0, 5).map((job) => ({
        externalId: job.externalId,
        title: job.title,
        publisher: job.publisher,
        regionLabels: (job.workLocations || []).map((location) => location.label),
        applyUrl: job.applyUrl,
      })),
    },
    safety: {
      previewOnly: collection.commit === false,
      credentialsPersisted: false,
      rawResponsesIncludedInSummary: false,
      missingJobClosureSuppressed: result.storage.missingAdvanceSuppressed,
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`黄雀实时来源检查失败 [${error.code || "ERROR"}]：${error.message}\n`);
  process.exitCode = 1;
});
