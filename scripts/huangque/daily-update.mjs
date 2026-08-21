#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HuangqueEngine } from "./lib/engine.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = resolve(process.env.HUANGQUE_RUNTIME_ROOT || resolve(projectRoot, ".huangque"));
const registryPath = resolve(process.env.HUANGQUE_REGISTRY_PATH || resolve(runtimeRoot, "state.json"));
const artifactRoot = resolve(process.env.HUANGQUE_ARTIFACT_ROOT || resolve(runtimeRoot, "artifacts"));
const employerUniversePath = resolve(process.env.HUANGQUE_EMPLOYER_UNIVERSE_PATH || resolve(projectRoot, "data/huangque/employer-universe.json"));
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
const dailyPath = resolve(runtimeRoot, `job-updates/${scheduledDate}.json`);
const latestPath = resolve(runtimeRoot, "latest-job-update.json");
const startedAt = new Date().toISOString();
let previous = null;
let previousReceiptError = null;
try {
  previous = await readJsonIfPresent(latestPath);
} catch (error) {
  // A corrupt latest marker must not make the process disappear before it can
  // write a receipt for this attempt. Continue safely and preserve the parse
  // failure in the replacement receipt.
  previousReceiptError = {
    code: error.code || "PREVIOUS_RECEIPT_INVALID",
    message: String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 500),
  };
}
if (["completed", "completed_with_findings", "no_work"].includes(previous?.status)
  && previous?.scheduledDate === scheduledDate && !force) {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "already_completed_for_beijing_date", scheduledDate, previous }, null, 2)}\n`);
  process.exit(0);
}

try {
  const engine = new HuangqueEngine({ projectRoot, registryPath, artifactRoot, employerUniversePath });
  // Bootstrap is inside the receipt boundary: even seed/storage failure must
  // produce an explicit failed job-update report.
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  const update = await engine.runJobUpdate({
    commitApproved: true,
    maxCollections: Number(process.env.HUANGQUE_DAILY_MAX_COLLECTIONS || 100),
  });
  const projection = await engine.exportHostedProjection({ outputPath: resolve(runtimeRoot, "hosted-snapshot.json") });
  const trigger = process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual";
  const audit = await engine.audit({
    outputPath: resolve(runtimeRoot, "latest-audit.json"),
    schedulerObservation: {
      trigger,
      stage: "post_pipeline_finalization",
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      scheduledDate,
    },
  });
  const report = {
    schemaVersion: "huangque.job-update-receipt.v1",
    timezone: "Asia/Shanghai",
    trigger,
    scheduledDate,
    scheduledLocalTime: "00:17",
    startedAt,
    completedAt: new Date().toISOString(),
    status: update.status,
    warnings: previousReceiptError ? [{ kind: "previous_receipt_invalid", ...previousReceiptError }] : [],
    update,
    projection,
    audit: audit.result,
  };
  // The dated archive is prepared first; latest-daily is the authoritative,
  // idempotency-driving commit and is written atomically only after audit.
  await atomicJson(dailyPath, report);
  await atomicJson(latestPath, report);
  if (["failed", "partial"].includes(update.status)) {
    process.stderr.write(`黄雀岗位更新状态为 ${update.status}；已保存证据，同一天允许重试。\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  const report = {
    schemaVersion: "huangque.job-update-receipt.v1",
    timezone: "Asia/Shanghai",
    trigger: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual",
    scheduledDate,
    scheduledLocalTime: "00:17",
    startedAt,
    failedAt: new Date().toISOString(),
    status: "failed",
    warnings: previousReceiptError ? [{ kind: "previous_receipt_invalid", ...previousReceiptError }] : [],
    error: { code: error.code || "DAILY_UPDATE_FAILED", message: error.message },
  };
  await atomicJson(dailyPath, report);
  await atomicJson(latestPath, report);
  process.stderr.write(`黄雀每日更新失败 [${report.error.code}]：${report.error.message}\n`);
  process.exitCode = 1;
}
