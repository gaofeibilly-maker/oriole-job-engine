#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse as parsePath, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HuangqueEngine } from "./lib/engine.mjs";
import { validateEmployerUniverse } from "./lib/employer-universe.mjs";
import {
  SOURCE_SPIDER_STATE_SCHEMA_VERSION,
  validateSourceSpiderState,
} from "./lib/source-spider.mjs";
import { packStateBundle } from "./state-bundle.mjs";

export const STATE_INITIALIZATION_SUMMARY_SCHEMA_VERSION = "huangque.state-initialization-summary.v1";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(scriptDirectory, "../..");
const EXPECTED_FINAL_FILES = Object.freeze([
  "employer-universe.json",
  "registry.bundle-manifest.json",
  "registry.json.gz",
  "source-spider-state.json",
]);

function initializationError(message, code = "INVALID_STATE_INITIALIZATION_INPUT") {
  return Object.assign(new Error(message), { code });
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw initializationError(`${label} 无效`);
  }
  return resolve(value.trim());
}

function outputDirectory(value) {
  const output = requiredPath(value, "output");
  if (output === parsePath(output).root) {
    throw initializationError("output 不能是文件系统根目录", "UNSAFE_STATE_OUTPUT");
  }
  return output;
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw initializationError("now 必须是有效时间");
  return date.toISOString();
}

async function lstatIfPresent(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(path) {
  const parsed = parsePath(path);
  const components = path.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = join(current, component);
    const metadata = await lstatIfPresent(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink()) {
      throw initializationError(`output 路径包含符号链接：${current}`, "UNSAFE_STATE_OUTPUT");
    }
    if (current !== path && !metadata.isDirectory()) {
      throw initializationError(`output 的父路径不是目录：${current}`, "UNSAFE_STATE_OUTPUT");
    }
  }
}

async function inspectOutput(path) {
  await assertNoSymlinkComponents(path);
  const metadata = await lstatIfPresent(path);
  if (!metadata) return { exists: false, path };
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw initializationError("output 必须是实际目录，不能是文件或符号链接", "UNSAFE_STATE_OUTPUT");
  }
  const entries = await readdir(path);
  if (entries.length !== 0) {
    throw initializationError("output 必须不存在或是空目录", "STATE_OUTPUT_NOT_EMPTY");
  }
  return { exists: true, path, device: metadata.dev, inode: metadata.ino };
}

async function ensureSafeParent(path) {
  const parent = dirname(path);
  await assertNoSymlinkComponents(parent);
  const metadata = await lstatIfPresent(parent);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw initializationError("output 的直接父目录必须已存在且不能是符号链接", "UNSAFE_STATE_OUTPUT");
  }
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) {
    throw initializationError("output 的父路径不能经由符号链接解析", "UNSAFE_STATE_OUTPUT");
  }
  return parent;
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readVerifiedSeedFacts(projectRoot) {
  const path = resolve(projectRoot, "data/huangque/verified-source-seeds.json");
  let payload;
  try { payload = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    throw initializationError(`无法读取已核验来源种子：${error.message}`, "VERIFIED_SEED_FACTS_INVALID");
  }
  if (payload?.metadata?.schemaVersion !== "huangque.verified-source-seeds.v1"
    || !Array.isArray(payload.sources) || payload.sources.length === 0
    || !Array.isArray(payload.jobs) || payload.jobs.length !== 0) {
    throw initializationError("已核验来源种子必须是非空来源清单且不携带岗位", "VERIFIED_SEED_FACTS_INVALID");
  }
  const ids = payload.sources.map((source) => source?.id);
  if (new Set(ids).size !== payload.sources.length
    || payload.sources.some((source) => !source?.id || source.fetchStatus !== "ok" || Number(source.jobs) !== 0)) {
    throw initializationError("已核验来源种子包含重复、未核验或携带岗位的记录", "VERIFIED_SEED_FACTS_INVALID");
  }
  return { path, payload, expectedSources: payload.sources.length };
}

async function copyCheckedEmployerUniverse(projectRoot, destination) {
  const source = resolve(projectRoot, "data/huangque/employer-universe.json");
  const metadata = await lstatIfPresent(source);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw initializationError("checked employer-universe 必须是普通文件", "EMPLOYER_UNIVERSE_COPY_INVALID");
  }
  const bytes = await readFile(source);
  let payload;
  try { payload = validateEmployerUniverse(JSON.parse(bytes.toString("utf8"))); }
  catch (error) {
    throw initializationError(`checked employer-universe 校验失败：${error.message}`, "EMPLOYER_UNIVERSE_COPY_INVALID");
  }
  await atomicWrite(destination, bytes);
  return payload;
}

function emptySourceSpiderState(initializedAt) {
  return validateSourceSpiderState({
    schemaVersion: SOURCE_SPIDER_STATE_SCHEMA_VERSION,
    revision: 0,
    createdAt: initializedAt,
    updatedAt: initializedAt,
    targets: {},
    runs: [],
  });
}

function assertCleanBootstrappedRegistry(state, expectedSources) {
  const approved = state.sources.filter((source) => source.lifecycle === "approved"
    && source.reviewStatus === "approved"
    && source.verificationState === "verified"
    && source.collectionEnabled === true);
  if (state.sources.length !== expectedSources || approved.length !== expectedSources) {
    throw initializationError("Registry 未精确包含全部 approved verified seeds", "STATE_BOOTSTRAP_INCOMPLETE");
  }
  if (state.jobs.length !== 0 || state.jobVersions.length !== 0 || state.runs.length !== 0) {
    throw initializationError("Registry 初始化必须保持零岗位、零岗位版本和零运行", "STATE_BOOTSTRAP_NOT_CLEAN");
  }
  if (state.sources.some((source) => !source.candidate?.decision?.reasonCodes?.includes("VERIFIED_SOURCE_SEED"))) {
    throw initializationError("Registry 包含非 verified seed 来源", "STATE_BOOTSTRAP_NOT_CLEAN");
  }
  return approved;
}

async function assertFinalStagingInventory(stagingDirectory) {
  const entries = (await readdir(stagingDirectory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(EXPECTED_FINAL_FILES)) {
    throw initializationError(`初始化目录包含非预期文件：${entries.join(",")}`, "STATE_INITIALIZATION_INVENTORY_INVALID");
  }
  if (await lstatIfPresent(join(stagingDirectory, "registry.json"))) {
    throw initializationError("初始化结果不得持久化明文 registry.json", "PLAINTEXT_REGISTRY_PERSISTED");
  }
}

async function commitStagingDirectory(stagingDirectory, output, original) {
  if (!original.exists) {
    if (await lstatIfPresent(output)) {
      throw initializationError("output 在初始化期间被其他进程创建", "STATE_OUTPUT_CHANGED");
    }
    await rename(stagingDirectory, output);
    return;
  }

  const current = await inspectOutput(output);
  if (!current.exists || current.device !== original.device || current.inode !== original.inode) {
    throw initializationError("output 在初始化期间发生变化", "STATE_OUTPUT_CHANGED");
  }
  const backup = join(dirname(output), `.${basename(output)}.oriole-empty.${process.pid}.${randomUUID()}`);
  await rename(output, backup);
  let committed = false;
  try {
    if ((await readdir(backup)).length !== 0) {
      throw initializationError("output 在提交前不再为空", "STATE_OUTPUT_CHANGED");
    }
    await rename(stagingDirectory, output);
    committed = true;
  } catch (error) {
    if (!committed) {
      await rename(backup, output).catch((rollbackError) => {
        throw initializationError(`初始化失败且空目录回滚失败：${rollbackError.message}`, "STATE_INITIALIZATION_ROLLBACK_FAILED");
      });
    }
    throw error;
  }
  await rmdir(backup);
}

export function parseInitializeStateArguments(argv) {
  if (!Array.isArray(argv)) throw initializationError("参数必须是数组");
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw initializationError(`未知参数：${token}`);
    }
    const flag = token.slice(2);
    if (flag !== "output") throw initializationError(`未知参数：--${flag}`);
    if (Object.hasOwn(values, flag)) throw initializationError(`参数重复：--${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw initializationError(`参数缺少值：--${flag}`);
    }
    values[flag] = value;
    index += 1;
  }
  if (!Object.hasOwn(values, "output")) throw initializationError("缺少必需参数：--output");
  return { output: outputDirectory(values.output) };
}

export async function initializeState({
  output,
  projectRoot = defaultProjectRoot,
  now = new Date(),
  packStateBundleImpl = packStateBundle,
} = {}) {
  const outputPath = outputDirectory(output);
  const root = requiredPath(projectRoot, "projectRoot");
  const initializedAt = isoTimestamp(typeof now === "function" ? now() : now);
  const original = await inspectOutput(outputPath);
  const parent = await ensureSafeParent(outputPath);
  const stagingDirectory = join(parent, `.${basename(outputPath)}.oriole-init.${process.pid}.${randomUUID()}`);
  await mkdir(stagingDirectory, { mode: 0o700 });
  let stagingCommitted = false;
  try {
    const seedFacts = await readVerifiedSeedFacts(root);
    const employerUniverse = await copyCheckedEmployerUniverse(root, join(stagingDirectory, "employer-universe.json"));
    const sourceSpiderState = emptySourceSpiderState(initializedAt);
    await atomicWriteJson(join(stagingDirectory, "source-spider-state.json"), sourceSpiderState);

    const engine = new HuangqueEngine({
      projectRoot: root,
      registryPath: join(stagingDirectory, "registry.json"),
      artifactRoot: join(stagingDirectory, ".artifacts"),
      existingSnapshotPath: join(stagingDirectory, ".disabled-existing-snapshot.json"),
      verifiedSourceSeedsPath: seedFacts.path,
      employerUniversePath: join(stagingDirectory, "employer-universe.json"),
      sourceSpiderStatePath: join(stagingDirectory, "source-spider-state.json"),
      now: () => new Date(initializedAt),
    });
    const bootstrap = await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
    const registry = await engine.registry.snapshot();
    const approved = assertCleanBootstrappedRegistry(registry, seedFacts.expectedSources);
    if (bootstrap.bootstrapMode !== "verified_source_seeds"
      || bootstrap.imported !== seedFacts.expectedSources
      || bootstrap.jobs.received !== 0) {
      throw initializationError("verified seed bootstrap 汇总与 Registry 不一致", "STATE_BOOTSTRAP_INCOMPLETE");
    }

    const manifest = await packStateBundleImpl({ stateDir: stagingDirectory, packedAt: initializedAt });
    await unlink(join(stagingDirectory, "registry.json"));
    await assertFinalStagingInventory(stagingDirectory);

    const summary = {
      schemaVersion: STATE_INITIALIZATION_SUMMARY_SCHEMA_VERSION,
      status: "completed",
      initializedAt,
      output: outputPath,
      registry: {
        schemaVersion: registry.schemaVersion,
        revision: registry.revision,
        seededSources: registry.sources.length,
        approvedVerifiedSources: approved.length,
        jobs: registry.jobs.length,
        runs: registry.runs.length,
        plaintextPersisted: false,
      },
      employerUniverse: {
        schemaVersion: employerUniverse.schemaVersion,
        generatedAt: employerUniverse.metadata.generatedAt,
        complete: employerUniverse.metadata.complete,
        targets: employerUniverse.targets.length,
        sources: employerUniverse.sources.length,
      },
      sourceSpiderState: {
        schemaVersion: sourceSpiderState.schemaVersion,
        revision: sourceSpiderState.revision,
        targets: Object.keys(sourceSpiderState.targets).length,
        runs: sourceSpiderState.runs.length,
      },
      bundle: manifest,
      receiptsCreated: 0,
      files: [...EXPECTED_FINAL_FILES],
    };

    await commitStagingDirectory(stagingDirectory, outputPath, original);
    stagingCommitted = true;
    return summary;
  } finally {
    if (!stagingCommitted) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function runInitializeStateCli(argv = process.argv.slice(2)) {
  const parsed = parseInitializeStateArguments(argv);
  const summary = await initializeState(parsed);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInitializeStateCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error?.code || "STATE_INITIALIZATION_FAILED",
      message: error?.message || String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
