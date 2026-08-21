#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { parse as parsePath, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";

export const STATE_BUNDLE_MANIFEST_SCHEMA_VERSION = "huangque.state-bundle-manifest.v1";
export const REGISTRY_SCHEMA_VERSION = "huangque.registry.v1";
export const MAX_COMPRESSED_BUNDLE_BYTES = 90 * 1024 * 1024;
export const MAX_UNCOMPRESSED_REGISTRY_BYTES = 512 * 1024 * 1024;

const REGISTRY_FILENAME = "registry.json";
const BUNDLE_FILENAME = "registry.json.gz";
const MANIFEST_FILENAME = "registry.bundle-manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const CLI_FLAGS = new Set(["state-dir"]);

function bundleError(message, code = "INVALID_STATE_BUNDLE_INPUT") {
  return Object.assign(new Error(message), { code });
}

function requiredString(value, label, maximumLength = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw bundleError(`${label} 无效`);
  }
  return value.trim();
}

function stateDirectory(value) {
  const directory = resolve(requiredString(value, "state-dir"));
  if (directory === parsePath(directory).root) {
    throw bundleError("state-dir 不能是文件系统根目录", "UNSAFE_STATE_DIRECTORY");
  }
  return directory;
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw bundleError(`${label} 必须是 ${minimum} 到 ${maximum} 之间的安全整数`, "INVALID_BUNDLE_MANIFEST");
  }
  return value;
}

function validateRegistry(registry, label = "Registry") {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw bundleError(`${label} 必须是 JSON 对象`, "INVALID_REGISTRY");
  }
  if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw bundleError(`${label}.schemaVersion 必须是 ${REGISTRY_SCHEMA_VERSION}`, "INVALID_REGISTRY");
  }
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) {
    throw bundleError(`${label}.revision 必须是非负安全整数`, "INVALID_REGISTRY");
  }
  return { schemaVersion: registry.schemaVersion, revision: registry.revision };
}

function parseRegistry(bytes, label = "Registry") {
  let registry;
  try {
    registry = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw bundleError(`${label} 不是有效 JSON`, "INVALID_REGISTRY");
  }
  return validateRegistry(registry, label);
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw bundleError("packedAt 必须是有效时间");
  return date.toISOString();
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw bundleError(`${label} 必须是小写 64 位 SHA256`, "INVALID_BUNDLE_MANIFEST");
  }
  return value;
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== STATE_BUNDLE_MANIFEST_SCHEMA_VERSION) {
    throw bundleError("Bundle manifest 结构或 schemaVersion 无效", "INVALID_BUNDLE_MANIFEST");
  }
  const packedAt = value.packedAt;
  if (typeof packedAt !== "string" || (() => {
    try { return new Date(packedAt).toISOString() !== packedAt; }
    catch { return true; }
  })()) {
    throw bundleError("Bundle manifest packedAt 无效", "INVALID_BUNDLE_MANIFEST");
  }
  const registry = value.registry;
  const bundle = value.bundle;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)
    || registry.path !== REGISTRY_FILENAME
    || registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw bundleError("Bundle manifest registry 描述无效", "INVALID_BUNDLE_MANIFEST");
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)
    || bundle.path !== BUNDLE_FILENAME || bundle.encoding !== "gzip") {
    throw bundleError("Bundle manifest bundle 描述无效", "INVALID_BUNDLE_MANIFEST");
  }
  safeInteger(registry.revision, "manifest.registry.revision");
  safeInteger(registry.bytes, "manifest.registry.bytes", {
    minimum: 1,
    maximum: MAX_UNCOMPRESSED_REGISTRY_BYTES,
  });
  safeInteger(bundle.bytes, "manifest.bundle.bytes", {
    minimum: 1,
    maximum: MAX_COMPRESSED_BUNDLE_BYTES,
  });
  safeInteger(bundle.maxBytes, "manifest.bundle.maxBytes", {
    minimum: 1,
    maximum: MAX_COMPRESSED_BUNDLE_BYTES,
  });
  if (bundle.bytes > bundle.maxBytes) {
    throw bundleError("压缩包超过 manifest 声明上限", "INVALID_BUNDLE_MANIFEST");
  }
  validateSha256(registry.sha256, "manifest.registry.sha256");
  validateSha256(bundle.sha256, "manifest.bundle.sha256");
  return value;
}

async function regularFile(path, label, { maximumBytes, allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw bundleError(`${label} 无法读取：${error.message}`, "STATE_BUNDLE_FILE_UNREADABLE");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw bundleError(`${label} 必须是普通文件且不能是符号链接`, "UNSAFE_STATE_BUNDLE_PATH");
  }
  if (maximumBytes !== undefined && (metadata.size <= 0 || metadata.size > maximumBytes)) {
    throw bundleError(`${label} 大小必须在 1 到 ${maximumBytes} 字节之间`, "STATE_BUNDLE_SIZE_INVALID");
  }
  return metadata;
}

async function ensureStateDirectory(path) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { throw bundleError(`state-dir 无法读取：${error.message}`, "STATE_DIRECTORY_UNREADABLE"); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw bundleError("state-dir 必须是实际目录且不能是符号链接", "UNSAFE_STATE_DIRECTORY");
  }
}

function meter({ maximumBytes, label }) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        callback(bundleError(`${label} 超过 ${maximumBytes} 字节上限`, "STATE_BUNDLE_SIZE_LIMIT"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    result() { return { bytes, sha256: hash.digest("hex") }; },
  };
}

async function hashFile(path, label, maximumBytes) {
  const measurement = meter({ maximumBytes, label });
  await pipeline(
    createReadStream(path),
    measurement.stream,
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  );
  return measurement.result();
}

async function unlinkIfPresent(path) {
  await unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}

function temporaryPath(finalPath, suffix = "tmp") {
  return `${finalPath}.${process.pid}.${randomUUID()}.${suffix}`;
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function transactionalReplacePair({ stagedBundle, stagedManifest, bundlePath, manifestPath }) {
  const bundleBackup = temporaryPath(bundlePath, "backup");
  const manifestBackup = temporaryPath(manifestPath, "backup");
  let bundleBackedUp = false;
  let manifestBackedUp = false;
  let bundleInstalled = false;
  let manifestInstalled = false;
  let committed = false;
  try {
    if (await regularFile(bundlePath, "现有压缩包", { allowMissing: true })) {
      await rename(bundlePath, bundleBackup);
      bundleBackedUp = true;
    }
    if (await regularFile(manifestPath, "现有 manifest", { allowMissing: true })) {
      await rename(manifestPath, manifestBackup);
      manifestBackedUp = true;
    }
    await rename(stagedBundle, bundlePath);
    bundleInstalled = true;
    await rename(stagedManifest, manifestPath);
    manifestInstalled = true;
    committed = true;
  } catch (error) {
    const rollbackErrors = [];
    if (manifestInstalled) await unlinkIfPresent(manifestPath).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (bundleInstalled) await unlinkIfPresent(bundlePath).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (bundleBackedUp) await rename(bundleBackup, bundlePath).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (manifestBackedUp) await rename(manifestBackup, manifestPath).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      throw bundleError(`安装新状态包失败，回滚也失败：${error.message}`, "STATE_BUNDLE_ROLLBACK_FAILED");
    }
    throw error;
  } finally {
    if (committed) {
      // The new pair is already committed. Backup cleanup must not turn that
      // successful commit into a reported failure.
      await unlinkIfPresent(bundleBackup).catch(() => {});
      await unlinkIfPresent(manifestBackup).catch(() => {});
    }
  }
}

function normalizedCompressedLimit(value) {
  if (value === undefined) return MAX_COMPRESSED_BUNDLE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw bundleError("compressedByteLimit 必须是正安全整数");
  }
  if (value > MAX_COMPRESSED_BUNDLE_BYTES) {
    throw bundleError(
      `compressedByteLimit 不能超过 ${MAX_COMPRESSED_BUNDLE_BYTES}`,
      "STATE_BUNDLE_LIMIT_CONFIGURATION_INVALID",
    );
  }
  return value;
}

export async function packStateBundle({ stateDir, packedAt, compressedByteLimit } = {}) {
  const directory = stateDirectory(stateDir);
  await ensureStateDirectory(directory);
  const registryPath = resolve(directory, REGISTRY_FILENAME);
  const bundlePath = resolve(directory, BUNDLE_FILENAME);
  const manifestPath = resolve(directory, MANIFEST_FILENAME);
  const limit = normalizedCompressedLimit(compressedByteLimit);

  const registryMetadata = await regularFile(registryPath, "registry.json", {
    maximumBytes: MAX_UNCOMPRESSED_REGISTRY_BYTES,
  });
  await regularFile(bundlePath, "现有压缩包", { allowMissing: true });
  await regularFile(manifestPath, "现有 manifest", { allowMissing: true });

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const registryHandle = await open(registryPath, flags);
  let registryHandleClosed = false;
  const stagedBundle = temporaryPath(bundlePath);
  const stagedManifest = temporaryPath(manifestPath);
  try {
    const openedMetadata = await registryHandle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== registryMetadata.size) {
      throw bundleError("registry.json 在打包前发生变化", "REGISTRY_CHANGED_DURING_PACK");
    }
    const registryBytes = await registryHandle.readFile();
    const registryIdentity = parseRegistry(registryBytes, "registry.json");
    const expectedPlainHash = createHash("sha256").update(registryBytes).digest("hex");
    const plainMeasurement = meter({
      maximumBytes: MAX_UNCOMPRESSED_REGISTRY_BYTES,
      label: "registry.json",
    });
    const compressedMeasurement = meter({ maximumBytes: limit, label: "registry.json.gz" });
    await pipeline(
      registryHandle.createReadStream({ start: 0, autoClose: false }),
      plainMeasurement.stream,
      createGzip({ level: 9 }),
      compressedMeasurement.stream,
      createWriteStream(stagedBundle, { flags: "wx", mode: 0o600 }),
    );
    const plain = plainMeasurement.result();
    const compressed = compressedMeasurement.result();
    if (plain.bytes !== registryBytes.byteLength || plain.sha256 !== expectedPlainHash) {
      throw bundleError("registry.json 在打包过程中发生变化", "REGISTRY_CHANGED_DURING_PACK");
    }
    const manifest = {
      schemaVersion: STATE_BUNDLE_MANIFEST_SCHEMA_VERSION,
      packedAt: isoTimestamp(packedAt),
      registry: {
        path: REGISTRY_FILENAME,
        schemaVersion: registryIdentity.schemaVersion,
        revision: registryIdentity.revision,
        sha256: plain.sha256,
        bytes: plain.bytes,
      },
      bundle: {
        path: BUNDLE_FILENAME,
        encoding: "gzip",
        sha256: compressed.sha256,
        bytes: compressed.bytes,
        maxBytes: limit,
      },
    };
    validateManifest(manifest);
    await writeJsonExclusive(stagedManifest, manifest);
    await registryHandle.close();
    registryHandleClosed = true;
    await transactionalReplacePair({ stagedBundle, stagedManifest, bundlePath, manifestPath });
    return manifest;
  } finally {
    if (!registryHandleClosed) await registryHandle.close().catch(() => {});
    await unlinkIfPresent(stagedBundle).catch(() => {});
    await unlinkIfPresent(stagedManifest).catch(() => {});
  }
}

export async function unpackStateBundle({ stateDir } = {}) {
  const directory = stateDirectory(stateDir);
  await ensureStateDirectory(directory);
  const registryPath = resolve(directory, REGISTRY_FILENAME);
  const bundlePath = resolve(directory, BUNDLE_FILENAME);
  const manifestPath = resolve(directory, MANIFEST_FILENAME);
  await regularFile(manifestPath, "Bundle manifest", { maximumBytes: MAX_MANIFEST_BYTES });
  await regularFile(bundlePath, "registry.json.gz", { maximumBytes: MAX_COMPRESSED_BUNDLE_BYTES });
  await regularFile(registryPath, "现有 registry.json", { allowMissing: true });

  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw bundleError("Bundle manifest 不是有效 JSON", "INVALID_BUNDLE_MANIFEST"); }
  validateManifest(manifest);

  const compressed = await hashFile(bundlePath, "registry.json.gz", MAX_COMPRESSED_BUNDLE_BYTES);
  if (compressed.bytes !== manifest.bundle.bytes || compressed.sha256 !== manifest.bundle.sha256) {
    throw bundleError("压缩包与 manifest 的 SHA256 或字节数不一致", "BUNDLE_HASH_MISMATCH");
  }

  const stagedRegistry = temporaryPath(registryPath);
  try {
    const plainMeasurement = meter({
      maximumBytes: Math.min(manifest.registry.bytes, MAX_UNCOMPRESSED_REGISTRY_BYTES),
      label: "解压后的 registry.json",
    });
    await pipeline(
      createReadStream(bundlePath),
      createGunzip(),
      plainMeasurement.stream,
      createWriteStream(stagedRegistry, { flags: "wx", mode: 0o600 }),
    );
    const plain = plainMeasurement.result();
    if (plain.bytes !== manifest.registry.bytes || plain.sha256 !== manifest.registry.sha256) {
      throw bundleError("解压内容与 manifest 的 SHA256 或字节数不一致", "REGISTRY_HASH_MISMATCH");
    }
    const restoredBytes = await readFile(stagedRegistry);
    const restoredIdentity = parseRegistry(restoredBytes, "解压后的 registry.json");
    if (restoredIdentity.schemaVersion !== manifest.registry.schemaVersion
      || restoredIdentity.revision !== manifest.registry.revision) {
      throw bundleError("解压 Registry 的 schemaVersion/revision 与 manifest 不一致", "REGISTRY_IDENTITY_MISMATCH");
    }
    await rename(stagedRegistry, registryPath);
    return manifest;
  } finally {
    await unlinkIfPresent(stagedRegistry).catch(() => {});
  }
}

export function parseStateBundleArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw bundleError("必须指定 pack 或 unpack");
  const command = argv[0];
  if (command !== "pack" && command !== "unpack") throw bundleError(`未知命令：${command}`);
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) throw bundleError(`未知参数：${token}`);
    const flag = token.slice(2);
    if (!CLI_FLAGS.has(flag)) throw bundleError(`未知参数：--${flag}`);
    if (Object.hasOwn(values, flag)) throw bundleError(`参数重复：--${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw bundleError(`参数缺少值：--${flag}`);
    values[flag] = next;
    index += 1;
  }
  if (!Object.hasOwn(values, "state-dir")) throw bundleError("缺少必需参数：--state-dir");
  return { command, stateDir: stateDirectory(values["state-dir"]) };
}

export async function runStateBundleCli(argv = process.argv.slice(2)) {
  const parsed = parseStateBundleArguments(argv);
  const manifest = parsed.command === "pack"
    ? await packStateBundle({ stateDir: parsed.stateDir })
    : await unpackStateBundle({ stateDir: parsed.stateDir });
  process.stdout.write(`${JSON.stringify({ status: "completed", command: parsed.command, manifest })}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runStateBundleCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error?.code ?? "STATE_BUNDLE_FAILED",
      message: error?.message ?? String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
