#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEmployerUniverse } from "./lib/employer-universe.mjs";
import { validateSourceSpiderState } from "./lib/source-spider.mjs";
import { unpackStateBundle } from "./state-bundle.mjs";

export const STATE_RECOVERY_SCHEMA_VERSION = "huangque.state-recovery.v2";

const MAX_REGISTRY_BYTES = 512 * 1024 * 1024;
const MAX_STATUS_BYTES = 10 * 1024 * 1024;
const MAX_JSON_STATE_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_FILES = 20_000;
const MAX_INVENTORY_BYTES = 1024 * 1024 * 1024;
const EPHEMERAL_RESTORED_FILES = new Set(["registry.json"]);
const TRANSIENT_STATE_FILE = /\.(?:lock|tmp|backup)$/;
const REQUIRED_FLAGS = new Set([
  "source-state-dir",
  "restored-state-dir",
  "status-report",
  "output",
  "repository",
  "workflow",
  "run-id",
  "run-attempt",
  "run-number",
  "commit-sha",
  "state-commit-sha",
  "ref",
  "event-name",
]);
const CLI_FLAGS = new Set([...REQUIRED_FLAGS, "completed-at"]);

function recoveryError(message, code = "INVALID_RECOVERY_INPUT", cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function requiredString(value, label, maximumLength = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw recoveryError(`${label} 无效`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw recoveryError(`${label} 必须是正整数`);
  return number;
}

function decimalIdentifier(value, label) {
  const normalized = requiredString(String(value ?? ""), label, 32);
  if (!/^[1-9]\d*$/.test(normalized)) throw recoveryError(`${label} 必须是非零十进制标识`);
  return normalized;
}

function githubIdentity(value) {
  const repository = requiredString(value?.repository, "repository", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw recoveryError("repository 必须是 owner/name");
  const commitSha = requiredString(value?.commitSha, "commit-sha", 64).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw recoveryError("commit-sha 必须是 40 位 Git SHA");
  const stateCommitSha = requiredString(value?.stateCommitSha, "state-commit-sha", 64).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(stateCommitSha)) throw recoveryError("state-commit-sha 必须是 40 位 Git SHA");
  const ref = requiredString(value?.ref, "ref", 300);
  if (!ref.startsWith("refs/")) throw recoveryError("ref 必须以 refs/ 开头");
  return {
    repository,
    workflow: requiredString(value?.workflow, "workflow", 200),
    runId: decimalIdentifier(value?.runId, "run-id"),
    runAttempt: positiveInteger(value?.runAttempt, "run-attempt"),
    runNumber: positiveInteger(value?.runNumber, "run-number"),
    commitSha,
    stateCommitSha,
    ref,
    eventName: requiredString(value?.eventName, "event-name", 100),
  };
}

function completedTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw recoveryError("completed-at 必须是有效时间");
  return date.toISOString();
}

function recoveryDirectory(value, label) {
  const directory = resolve(requiredString(value, label, 4_096));
  if (directory === parsePath(directory).root) {
    throw recoveryError(`${label} 不能是文件系统根目录`, "RECOVERY_UNSAFE_PATH");
  }
  return directory;
}

async function actualDirectory(path, label) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { throw recoveryError(`${label} 无法读取：${error.message}`, "RECOVERY_DIRECTORY_UNREADABLE", error); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw recoveryError(`${label} 必须是实际目录且不能是符号链接`, "RECOVERY_UNSAFE_PATH");
  }
}

async function boundedFile(path, label, maximumBytes, { optional = false } = {}) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw recoveryError(`${label} 无法读取：${error.message}`, "RECOVERY_FILE_UNREADABLE", error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw recoveryError(`${label} 必须是 1 到 ${maximumBytes} 字节的普通文件且不能是符号链接`, "RECOVERY_FILE_INVALID");
  }
  return readFile(path);
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw recoveryError(`${label} 不是有效 JSON`, "RECOVERY_JSON_INVALID"); }
}

function nonnegativeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw recoveryError(`${label} 必须是非负整数`, "RECOVERY_STATUS_INVALID");
  }
  return value;
}

function verifiedSummary(registry, status) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)
    || registry.schemaVersion !== "huangque.registry.v1"
    || !Number.isSafeInteger(registry.revision) || registry.revision < 0
    || !Array.isArray(registry.sources) || !Array.isArray(registry.jobs)
    || !Array.isArray(registry.edges) || !Array.isArray(registry.runs)) {
    throw recoveryError("恢复的 Registry 结构无效", "RECOVERY_REGISTRY_INVALID");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)
    || status.schemaVersion !== "huangque.status.v1") {
    throw recoveryError("Agent status 结构无效", "RECOVERY_STATUS_INVALID");
  }
  const sourceCounts = Object.fromEntries(["candidate", "probed", "approved", "rejected"].map((lifecycle) => [
    lifecycle,
    registry.sources.filter((source) => source?.lifecycle === lifecycle).length,
  ]));
  const expected = {
    registryRevision: registry.revision,
    jobs: registry.jobs.length,
    graphEdges: registry.edges.length,
    runs: registry.runs.length,
    sourceCounts,
  };
  const reported = {
    registryRevision: nonnegativeCount(status.registryRevision, "status.registryRevision"),
    jobs: nonnegativeCount(status.jobs, "status.jobs"),
    graphEdges: nonnegativeCount(status.graphEdges, "status.graphEdges"),
    runs: nonnegativeCount(status.runs, "status.runs"),
    sourceCounts: Object.fromEntries(Object.keys(sourceCounts).map((lifecycle) => [
      lifecycle,
      nonnegativeCount(status.sourceCounts?.[lifecycle], `status.sourceCounts.${lifecycle}`),
    ])),
  };
  if (JSON.stringify(reported) !== JSON.stringify(expected)) {
    throw recoveryError("Agent status 摘要与恢复 Registry 不一致", "RECOVERY_STATUS_MISMATCH");
  }
  return {
    registryRevision: expected.registryRevision,
    sources: registry.sources.length,
    sourceCounts,
    jobs: expected.jobs,
    graphEdges: expected.graphEdges,
    runs: expected.runs,
  };
}

function pathsOverlap(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return left === right
    || (leftToRight && leftToRight !== ".." && !leftToRight.startsWith(`..${sep}`))
    || (rightToLeft && rightToLeft !== ".." && !rightToLeft.startsWith(`..${sep}`));
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function portableRelativePath(path) {
  const value = path.split(sep).join("/");
  if (!value || value.startsWith("/") || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw recoveryError(`状态文件路径不安全：${JSON.stringify(value)}`, "RECOVERY_UNSAFE_PATH");
  }
  return value;
}

async function stateInventory(root, { allowRestoredRegistry = false } = {}) {
  const entries = [];
  let totalBytes = 0;
  async function walk(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relativePath = portableRelativePath(prefix ? join(prefix, child.name) : child.name);
      const absolutePath = join(directory, child.name);
      if (child.isSymbolicLink()) {
        throw recoveryError(`状态清单拒绝符号链接：${relativePath}`, "RECOVERY_UNSAFE_PATH");
      }
      if (TRANSIENT_STATE_FILE.test(relativePath)) {
        throw recoveryError(`持久状态包含临时路径：${relativePath}`, "RECOVERY_TRANSIENT_STATE_FILE");
      }
      if (child.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!child.isFile()) {
        throw recoveryError(`状态清单只允许普通文件：${relativePath}`, "RECOVERY_UNSAFE_PATH");
      }
      if (child.name === "registry.json") {
        if (allowRestoredRegistry && EPHEMERAL_RESTORED_FILES.has(relativePath)) continue;
        throw recoveryError("持久状态不得包含明文 registry.json", "PLAINTEXT_REGISTRY_PERSISTED");
      }
      const metadata = await lstat(absolutePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw recoveryError(`状态文件在读取时发生变化：${relativePath}`, "RECOVERY_UNSAFE_PATH");
      }
      if (metadata.size > MAX_REGISTRY_BYTES) {
        throw recoveryError(`状态文件超过单文件上限：${relativePath}`, "RECOVERY_INVENTORY_LIMIT");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_INVENTORY_BYTES || entries.length >= MAX_INVENTORY_FILES) {
        throw recoveryError("完整状态清单超过审计上限", "RECOVERY_INVENTORY_LIMIT");
      }
      entries.push({ path: relativePath, bytes: metadata.size, sha256: await fileSha256(absolutePath) });
    }
  }
  await walk(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    fileCount: entries.length,
    totalBytes,
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    files: entries,
  };
}

function inventorySummary(inventory) {
  return {
    fileCount: inventory.fileCount,
    totalBytes: inventory.totalBytes,
    sha256: inventory.sha256,
  };
}

function inventoryFile(inventory, artifact) {
  const entry = inventory.files.find((item) => item.path === artifact);
  if (!entry) throw recoveryError(`完整状态清单缺少 ${artifact}`, "RECOVERY_REQUIRED_STATE_MISSING");
  return entry;
}

function validateOptionalReceipt(value, kind) {
  const expectedSchema = kind === "job"
    ? "huangque.job-update-receipt.v1"
    : "huangque.source-spider-run.v1";
  const allowedStatuses = kind === "job"
    ? new Set(["completed", "completed_with_findings", "no_work", "partial", "failed"])
    : new Set(["completed", "completed_with_findings", "no_work", "partial", "failed"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== expectedSchema || !allowedStatuses.has(value.status)) {
    throw recoveryError(
      `${kind === "job" ? "岗位更新" : "寻源蜘蛛"} latest receipt 结构无效`,
      "RECOVERY_LATEST_RECEIPT_INVALID",
    );
  }
  const timestampFields = ["completedAt", "failedAt"].filter((field) => value[field] !== undefined);
  if (timestampFields.length === 0) {
    throw recoveryError("latest receipt 缺少完成或失败时间", "RECOVERY_LATEST_RECEIPT_INVALID");
  }
  for (const field of timestampFields) {
    let normalized;
    try { normalized = new Date(value[field]).toISOString(); }
    catch { normalized = null; }
    if (typeof value[field] !== "string" || normalized !== value[field]) {
      throw recoveryError(`latest receipt ${field} 无效`, "RECOVERY_LATEST_RECEIPT_INVALID");
    }
  }
  return value;
}

async function optionalReceipt(stateDir, inventory, artifact, kind) {
  const bytes = await boundedFile(join(stateDir, artifact), artifact, MAX_JSON_STATE_BYTES, { optional: true });
  const persistedArtifact = `state-data/${artifact}`;
  if (!bytes) return { present: false, artifact: persistedArtifact };
  const value = validateOptionalReceipt(parseJson(bytes, artifact), kind);
  const entry = inventoryFile(inventory, artifact);
  return {
    present: true,
    artifact: persistedArtifact,
    schemaVersion: value.schemaVersion,
    status: value.status,
    completedAt: value.completedAt || null,
    failedAt: value.failedAt || null,
    sha256: entry.sha256,
    bytes: entry.bytes,
  };
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function createStateRecoveryReceipt({
  sourceStateDir,
  restoredStateDir,
  statusReportPath,
  outputPath,
  github,
  completedAt,
}) {
  const paths = {
    sourceStateDir: recoveryDirectory(sourceStateDir, "source-state-dir"),
    restoredStateDir: recoveryDirectory(restoredStateDir, "restored-state-dir"),
    statusReportPath: resolve(requiredString(statusReportPath, "status-report", 4_096)),
    outputPath: resolve(requiredString(outputPath, "output", 4_096)),
  };
  if (pathsOverlap(paths.sourceStateDir, paths.restoredStateDir)) {
    throw recoveryError("源状态目录与隔离恢复目录必须彼此独立", "RECOVERY_PATHS_NOT_DISTINCT");
  }
  if (paths.outputPath !== join(paths.sourceStateDir, "latest-state-recovery.json")) {
    throw recoveryError("回执只能原子写入源状态目录的 latest-state-recovery.json", "RECOVERY_OUTPUT_CONFLICT");
  }
  if (paths.statusReportPath === paths.outputPath) {
    throw recoveryError("Agent status 不能与恢复回执共用路径", "RECOVERY_OUTPUT_CONFLICT");
  }
  await Promise.all([
    actualDirectory(paths.sourceStateDir, "源状态目录"),
    actualDirectory(paths.restoredStateDir, "隔离恢复目录"),
  ]);
  try {
    await lstat(join(paths.sourceStateDir, "registry.json"));
    throw recoveryError("oriole-state 不得持久化明文 registry.json", "PLAINTEXT_REGISTRY_PERSISTED");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const identity = githubIdentity(github);

  // Re-run unpack inside the receipt boundary. This re-verifies manifest,
  // compressed hash, plaintext hash, bytes, schema, and revision immediately
  // before the machine receipt is committed.
  const bundleManifest = await unpackStateBundle({ stateDir: paths.restoredStateDir });
  const [sourceInventory, restoredInventory, statusBytes] = await Promise.all([
    stateInventory(paths.sourceStateDir),
    stateInventory(paths.restoredStateDir, { allowRestoredRegistry: true }),
    boundedFile(paths.statusReportPath, "Agent status", MAX_STATUS_BYTES),
  ]);
  if (JSON.stringify(sourceInventory.files) !== JSON.stringify(restoredInventory.files)
    || sourceInventory.sha256 !== restoredInventory.sha256) {
    throw recoveryError("源状态与隔离副本的完整文件清单哈希不一致", "RECOVERY_INVENTORY_MISMATCH");
  }

  const registryBytes = await boundedFile(
    join(paths.restoredStateDir, "registry.json"),
    "恢复 Registry",
    MAX_REGISTRY_BYTES,
  );
  const registry = parseJson(registryBytes, "恢复 Registry");
  const status = parseJson(statusBytes, "Agent status");
  const summary = verifiedSummary(registry, status);
  const registryHash = createHash("sha256").update(registryBytes).digest("hex");
  if (registryHash !== bundleManifest.registry.sha256
    || registryBytes.byteLength !== bundleManifest.registry.bytes
    || registry.revision !== bundleManifest.registry.revision
    || registry.schemaVersion !== bundleManifest.registry.schemaVersion) {
    throw recoveryError("恢复 Registry 与已验证 bundle manifest 不一致", "RECOVERY_REGISTRY_BUNDLE_MISMATCH");
  }

  const employerBytes = await boundedFile(
    join(paths.restoredStateDir, "employer-universe.json"),
    "employer-universe.json",
    MAX_JSON_STATE_BYTES,
  );
  const employerUniverse = parseJson(employerBytes, "employer-universe.json");
  try { validateEmployerUniverse(employerUniverse); }
  catch (error) {
    throw recoveryError(`employer-universe 验证失败：${error.message}`, "RECOVERY_EMPLOYER_UNIVERSE_INVALID", error);
  }

  const spiderStateBytes = await boundedFile(
    join(paths.restoredStateDir, "source-spider-state.json"),
    "source-spider-state.json",
    MAX_JSON_STATE_BYTES,
  );
  const spiderState = parseJson(spiderStateBytes, "source-spider-state.json");
  try { validateSourceSpiderState(spiderState); }
  catch (error) {
    throw recoveryError(`source-spider-state 验证失败：${error.message}`, "RECOVERY_SOURCE_SPIDER_STATE_INVALID", error);
  }

  const employerEntry = inventoryFile(sourceInventory, "employer-universe.json");
  const spiderStateEntry = inventoryFile(sourceInventory, "source-spider-state.json");
  const manifestEntry = inventoryFile(sourceInventory, "registry.bundle-manifest.json");
  const bundleEntry = inventoryFile(sourceInventory, "registry.json.gz");
  if (bundleEntry.sha256 !== bundleManifest.bundle.sha256
    || bundleEntry.bytes !== bundleManifest.bundle.bytes) {
    throw recoveryError("完整清单中的 Registry 压缩包与 manifest 不一致", "RECOVERY_REGISTRY_BUNDLE_MISMATCH");
  }
  const [latestJobUpdate, latestSourceSpider] = await Promise.all([
    optionalReceipt(paths.restoredStateDir, sourceInventory, "latest-job-update.json", "job"),
    optionalReceipt(paths.restoredStateDir, sourceInventory, "latest-source-spider.json", "spider"),
  ]);

  const receipt = {
    schemaVersion: STATE_RECOVERY_SCHEMA_VERSION,
    status: "completed",
    trigger: "github_actions",
    completedAt: completedTimestamp(completedAt),
    github: identity,
    registryBundle: {
      manifest: {
        artifact: "state-data/registry.bundle-manifest.json",
        schemaVersion: bundleManifest.schemaVersion,
        packedAt: bundleManifest.packedAt,
        sha256: manifestEntry.sha256,
        bytes: manifestEntry.bytes,
      },
      compressed: {
        artifact: "state-data/registry.json.gz",
        encoding: bundleManifest.bundle.encoding,
        sha256: bundleEntry.sha256,
        bytes: bundleEntry.bytes,
        maxBytes: bundleManifest.bundle.maxBytes,
      },
      restoredRegistry: {
        persistedInSourceBranch: false,
        schemaVersion: registry.schemaVersion,
        revision: registry.revision,
        sha256: registryHash,
        bytes: registryBytes.byteLength,
      },
    },
    stateInventory: {
      snapshotPhase: "copied_state_before_new_recovery_receipt",
      excludedEphemeralFiles: [...EPHEMERAL_RESTORED_FILES],
      source: inventorySummary(sourceInventory),
      restored: inventorySummary(restoredInventory),
      files: sourceInventory.files,
      matched: true,
    },
    employerUniverse: {
      artifact: "state-data/employer-universe.json",
      schemaVersion: employerUniverse.schemaVersion,
      generatedAt: employerUniverse.metadata.generatedAt,
      complete: employerUniverse.metadata.complete,
      targets: employerUniverse.targets.length,
      sources: employerUniverse.sources.length,
      sha256: employerEntry.sha256,
      bytes: employerEntry.bytes,
    },
    sourceSpiderState: {
      artifact: "state-data/source-spider-state.json",
      schemaVersion: spiderState.schemaVersion,
      revision: spiderState.revision,
      updatedAt: spiderState.updatedAt,
      targets: Object.keys(spiderState.targets).length,
      runs: spiderState.runs.length,
      sha256: spiderStateEntry.sha256,
      bytes: spiderStateEntry.bytes,
    },
    latestReceipts: {
      jobUpdate: latestJobUpdate,
      sourceSpider: latestSourceSpider,
    },
    agentStatus: {
      schemaVersion: status.schemaVersion,
      sha256: createHash("sha256").update(statusBytes).digest("hex"),
      bytes: statusBytes.byteLength,
      summary,
    },
    verification: {
      registryBundleVerified: true,
      completeInventoryMatched: true,
      employerUniverseValid: true,
      sourceSpiderStateValid: true,
      optionalLatestReceiptsValid: true,
      statusMatchedRegistry: true,
      sourcePlaintextRegistryAbsent: true,
      transientStateFilesAbsent: true,
    },
  };
  await writeAtomicJson(paths.outputPath, receipt);
  return receipt;
}

export function parseStateRecoveryArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) throw recoveryError(`未知参数：${token}`);
    const flag = token.slice(2);
    if (!CLI_FLAGS.has(flag)) throw recoveryError(`未知参数：--${flag}`);
    if (Object.hasOwn(values, flag)) throw recoveryError(`参数重复：--${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw recoveryError(`参数缺少值：--${flag}`);
    values[flag] = next;
    index += 1;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!Object.hasOwn(values, flag)) throw recoveryError(`缺少必需参数：--${flag}`);
  }
  return {
    sourceStateDir: values["source-state-dir"],
    restoredStateDir: values["restored-state-dir"],
    statusReportPath: values["status-report"],
    outputPath: values.output,
    github: {
      repository: values.repository,
      workflow: values.workflow,
      runId: values["run-id"],
      runAttempt: values["run-attempt"],
      runNumber: values["run-number"],
      commitSha: values["commit-sha"],
      stateCommitSha: values["state-commit-sha"],
      ref: values.ref,
      eventName: values["event-name"],
    },
    completedAt: values["completed-at"],
  };
}

async function main() {
  const input = parseStateRecoveryArguments(process.argv.slice(2));
  const receipt = await createStateRecoveryReceipt(input);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error?.code || "STATE_RECOVERY_RECEIPT_FAILED",
      message: error?.message || String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
