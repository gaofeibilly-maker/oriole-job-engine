#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HuangqueEngine } from "./lib/engine.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = resolve(process.env.HUANGQUE_REGISTRY_PATH || resolve(projectRoot, ".huangque/state.json"));
const artifactRoot = resolve(process.env.HUANGQUE_ARTIFACT_ROOT || resolve(projectRoot, ".huangque/artifacts"));
const force = process.argv.includes("--force");

function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function readJsonIfPresent(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

const scheduledDate = beijingDate();
const dailyPath = resolve(projectRoot, `.huangque/daily/${scheduledDate}.json`);
const latestPath = resolve(projectRoot, ".huangque/latest-daily.json");
const previous = await readJsonIfPresent(latestPath);
if (previous?.status === "completed" && previous?.scheduledDate === scheduledDate && !force) {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "already_completed_for_beijing_date", scheduledDate, previous }, null, 2)}\n`);
  process.exit(0);
}

const engine = new HuangqueEngine({ projectRoot, registryPath, artifactRoot });
// Sync the versioned reviewed seed manifest on every new Beijing-date run.
// The import is source-key idempotent: it adds newly reviewed sources without
// resetting the portable Registry or bypassing review for search candidates.
await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });

const startedAt = new Date().toISOString();
try {
  const pipeline = await engine.runDue({
    commitApproved: true,
    maxQueries: Number(process.env.HUANGQUE_DAILY_MAX_QUERIES || 20),
    maxProbes: Number(process.env.HUANGQUE_DAILY_MAX_PROBES || 8),
    maxCollections: Number(process.env.HUANGQUE_DAILY_MAX_COLLECTIONS || 100),
  });
  const projection = await engine.exportHostedProjection();
  const collectionFailed = Number(pipeline.collection?.failedSources || 0) > 0;
  const trigger = process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual";
  const audit = await engine.audit({
    outputPath: resolve(projectRoot, ".huangque/latest-audit.json"),
    schedulerObservation: {
      trigger,
      stage: "post_pipeline_finalization",
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      scheduledDate,
    },
  });
  const report = {
    schemaVersion: "huangque.daily-run.v1",
    timezone: "Asia/Shanghai",
    trigger,
    scheduledDate,
    scheduledLocalTime: "00:00",
    startedAt,
    completedAt: new Date().toISOString(),
    status: collectionFailed ? "failed" : "completed",
    pipeline,
    projection,
    audit: audit.result,
  };
  // The dated archive is prepared first; latest-daily is the authoritative,
  // idempotency-driving commit and is written atomically only after audit.
  await atomicJson(dailyPath, report);
  await atomicJson(latestPath, report);
  if (collectionFailed) {
    process.stderr.write(`黄雀每日更新有 ${pipeline.collection.failedSources} 个到期来源采集失败；已保存证据，同一天允许重试。\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  const report = {
    schemaVersion: "huangque.daily-run.v1",
    timezone: "Asia/Shanghai",
    trigger: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual",
    scheduledDate,
    scheduledLocalTime: "00:00",
    startedAt,
    failedAt: new Date().toISOString(),
    status: "failed",
    error: { code: error.code || "DAILY_UPDATE_FAILED", message: error.message },
  };
  await atomicJson(dailyPath, report);
  await atomicJson(latestPath, report);
  process.stderr.write(`黄雀每日更新失败 [${report.error.code}]：${report.error.message}\n`);
  process.exitCode = 1;
}
