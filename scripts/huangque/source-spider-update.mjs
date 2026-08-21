#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HuangqueEngine } from "./lib/engine.mjs";
import {
  combinedSourceSpiderStatus,
  runSourceSpider,
  sourceSpiderRunFingerprint,
} from "./lib/source-spider.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = resolve(process.env.HUANGQUE_RUNTIME_ROOT || resolve(projectRoot, ".huangque"));
const registryPath = resolve(process.env.HUANGQUE_REGISTRY_PATH || resolve(runtimeRoot, "state.json"));
const artifactRoot = resolve(process.env.HUANGQUE_ARTIFACT_ROOT || resolve(runtimeRoot, "artifacts"));
const universePath = resolve(process.env.HUANGQUE_EMPLOYER_UNIVERSE_PATH || resolve(projectRoot, "data/huangque/employer-universe.json"));
const spiderStatePath = resolve(process.env.HUANGQUE_SOURCE_SPIDER_STATE_PATH || resolve(runtimeRoot, "source-spider-state.json"));
const reportPath = resolve(runtimeRoot, "latest-source-spider.json");
const deep = process.argv.includes("--deep");

function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

const engine = new HuangqueEngine({ projectRoot, registryPath, artifactRoot });
const startedAt = new Date().toISOString();
try {
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  const report = await runSourceSpider(engine, {
    universePath,
    statePath: spiderStatePath,
    maxEmployers: Number(process.env.HUANGQUE_SOURCE_SPIDER_MAX_EMPLOYERS || (deep ? 300 : 100)),
    maxProbes: Number(process.env.HUANGQUE_SOURCE_SPIDER_MAX_PROBES || (deep ? 40 : 20)),
    maxCrawlPages: Number(process.env.HUANGQUE_SOURCE_SPIDER_MAX_CRAWL_PAGES || 20),
    deep,
  });
  const regionalGapScan = deep ? await engine.runPipeline({
    providers: ["official_catalog", "common_crawl", "baidu"],
    bucketIds: ["provincial-public", "prefecture-rotation", "company-careers", "parks-associations"],
    maxQueries: Number(process.env.HUANGQUE_DEEP_SCAN_MAX_QUERIES || 150),
    maxProbes: Number(process.env.HUANGQUE_DEEP_SCAN_MAX_PROBES || 20),
    collectApproved: false,
    commit: false,
    force: false,
  }) : null;
  const receipt = {
    ...report,
    status: combinedSourceSpiderStatus(report.status, regionalGapScan),
    sourceSpiderStatus: report.status,
    startedAt,
    regionalGapScan: regionalGapScan ? {
      status: regionalGapScan.status,
      discoveryRunId: regionalGapScan.discoveryRunId,
      discovered: regionalGapScan.discovered,
      probes: regionalGapScan.probes,
      probeQueue: regionalGapScan.probeQueue,
      providerRuns: regionalGapScan.providerRuns,
    } : null,
  };
  receipt.fingerprint = sourceSpiderRunFingerprint(receipt);
  await atomicJson(reportPath, receipt);
  await atomicJson(resolve(runtimeRoot, `source-spider-runs/${beijingDate()}-${deep ? "deep" : "daily"}.json`), receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!["completed", "completed_with_findings", "no_work"].includes(receipt.status)) process.exitCode = 1;
} catch (error) {
  const previous = await readJson(reportPath).catch(() => null);
  const failure = {
    schemaVersion: "huangque.source-spider-run.v1",
    timezone: "Asia/Shanghai",
    scheduledDate: beijingDate(),
    startedAt,
    failedAt: new Date().toISOString(),
    mode: deep ? "weekly_deep" : "daily",
    trigger: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual",
    githubRunId: process.env.GITHUB_RUN_ID || null,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    status: "failed",
    error: { code: error.code || "SOURCE_SPIDER_FAILED", message: error.message },
    previousSuccessfulRunAt: previous?.status !== "failed" ? previous?.completedAt || null : previous?.previousSuccessfulRunAt || null,
  };
  await atomicJson(reportPath, failure);
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}
