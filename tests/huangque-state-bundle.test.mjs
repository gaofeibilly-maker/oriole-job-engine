import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MAX_COMPRESSED_BUNDLE_BYTES,
  packStateBundle,
  parseStateBundleArguments,
  STATE_BUNDLE_MANIFEST_SCHEMA_VERSION,
  unpackStateBundle,
} from "../scripts/huangque/state-bundle.mjs";

const MANIFEST_FILENAME = "registry.bundle-manifest.json";
const BUNDLE_FILENAME = "registry.json.gz";

function registryFixture({ revision = 12, marker = "original", payload } = {}) {
  return {
    schemaVersion: "huangque.registry.v1",
    revision,
    sources: [],
    jobs: [],
    edges: [],
    runs: [],
    marker,
    ...(payload === undefined ? {} : { payload }),
  };
}

async function directoryFixture(prefix = "oriole-state-bundle-") {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeRegistry(directory, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(directory, "registry.json"), body);
  return body;
}

test("pack/unpack round trip records both hashes, byte counts, revision, and time", async () => {
  const directory = await directoryFixture();
  const original = await writeRegistry(directory, registryFixture());
  const manifest = await packStateBundle({
    stateDir: directory,
    packedAt: "2026-08-21T12:34:56.000Z",
  });

  assert.equal(manifest.schemaVersion, STATE_BUNDLE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.packedAt, "2026-08-21T12:34:56.000Z");
  assert.equal(manifest.registry.schemaVersion, "huangque.registry.v1");
  assert.equal(manifest.registry.revision, 12);
  assert.equal(manifest.registry.bytes, Buffer.byteLength(original));
  assert.equal(manifest.registry.sha256, createHash("sha256").update(original).digest("hex"));
  const compressed = await readFile(join(directory, BUNDLE_FILENAME));
  assert.equal(manifest.bundle.bytes, compressed.byteLength);
  assert.equal(manifest.bundle.sha256, createHash("sha256").update(compressed).digest("hex"));
  assert.equal(manifest.bundle.maxBytes, MAX_COMPRESSED_BUNDLE_BYTES);
  assert.deepEqual(JSON.parse(await readFile(join(directory, MANIFEST_FILENAME), "utf8")), manifest);

  await writeRegistry(directory, registryFixture({ revision: 99, marker: "must-be-replaced" }));
  const restoredManifest = await unpackStateBundle({ stateDir: directory });
  assert.deepEqual(restoredManifest, manifest);
  assert.equal(await readFile(join(directory, "registry.json"), "utf8"), original);
});

test("tampered gzip is rejected before decompression and never replaces registry.json", async () => {
  const directory = await directoryFixture("oriole-state-bundle-tamper-");
  await writeRegistry(directory, registryFixture());
  await packStateBundle({ stateDir: directory });
  const sentinel = await writeRegistry(directory, registryFixture({ revision: 91, marker: "keep-me" }));
  const bundlePath = join(directory, BUNDLE_FILENAME);
  const bundle = await readFile(bundlePath);
  await writeFile(bundlePath, Buffer.concat([bundle, Buffer.from("tampered")]));

  await assert.rejects(
    () => unpackStateBundle({ stateDir: directory }),
    (error) => error.code === "BUNDLE_HASH_MISMATCH",
  );
  assert.equal(await readFile(join(directory, "registry.json"), "utf8"), sentinel);
});

test("a structurally valid but corrupt gzip still cannot replace existing plaintext", async () => {
  const directory = await directoryFixture("oriole-state-bundle-corrupt-");
  await writeRegistry(directory, registryFixture());
  await packStateBundle({ stateDir: directory });
  const sentinel = await writeRegistry(directory, registryFixture({ revision: 92, marker: "still-here" }));
  const corrupt = Buffer.from("this is not gzip data");
  await writeFile(join(directory, BUNDLE_FILENAME), corrupt);
  const manifestPath = join(directory, MANIFEST_FILENAME);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bundle.bytes = corrupt.byteLength;
  manifest.bundle.sha256 = createHash("sha256").update(corrupt).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(() => unpackStateBundle({ stateDir: directory }));
  assert.equal(await readFile(join(directory, "registry.json"), "utf8"), sentinel);
});

test("pack size-limit failure leaves the previous valid gzip and manifest byte-for-byte intact", async () => {
  const directory = await directoryFixture("oriole-state-bundle-limit-");
  await writeRegistry(directory, registryFixture({ revision: 1 }));
  await packStateBundle({ stateDir: directory });
  const oldBundle = await readFile(join(directory, BUNDLE_FILENAME));
  const oldManifest = await readFile(join(directory, MANIFEST_FILENAME));

  await writeRegistry(directory, registryFixture({
    revision: 2,
    payload: randomBytes(4096).toString("hex"),
  }));
  await assert.rejects(
    () => packStateBundle({ stateDir: directory, compressedByteLimit: 128 }),
    (error) => error.code === "STATE_BUNDLE_SIZE_LIMIT",
  );
  assert.deepEqual(await readFile(join(directory, BUNDLE_FILENAME)), oldBundle);
  assert.deepEqual(await readFile(join(directory, MANIFEST_FILENAME)), oldManifest);
  assert.ok(MAX_COMPRESSED_BUNDLE_BYTES < 100 * 1024 * 1024);
  assert.equal(MAX_COMPRESSED_BUNDLE_BYTES, 90 * 1024 * 1024);
  await unpackStateBundle({ stateDir: directory });
  assert.equal(JSON.parse(await readFile(join(directory, "registry.json"), "utf8")).revision, 1);
  await assert.rejects(
    () => packStateBundle({
      stateDir: directory,
      compressedByteLimit: MAX_COMPRESSED_BUNDLE_BYTES + 1,
    }),
    (error) => error.code === "STATE_BUNDLE_LIMIT_CONFIGURATION_INVALID",
  );
});

test("invalid registry schemaVersion or revision fails before replacing a valid package", async () => {
  const directory = await directoryFixture("oriole-state-bundle-schema-");
  await writeRegistry(directory, registryFixture({ revision: 1 }));
  await packStateBundle({ stateDir: directory });
  const oldBundle = await readFile(join(directory, BUNDLE_FILENAME));
  const oldManifest = await readFile(join(directory, MANIFEST_FILENAME));

  await writeRegistry(directory, { schemaVersion: "unknown", revision: -1 });
  await assert.rejects(
    () => packStateBundle({ stateDir: directory }),
    (error) => error.code === "INVALID_REGISTRY",
  );
  assert.deepEqual(await readFile(join(directory, BUNDLE_FILENAME)), oldBundle);
  assert.deepEqual(await readFile(join(directory, MANIFEST_FILENAME)), oldManifest);
});

test("manifest revision tampering is rejected without touching plaintext", async () => {
  const directory = await directoryFixture("oriole-state-bundle-manifest-");
  await writeRegistry(directory, registryFixture({ revision: 5 }));
  await packStateBundle({ stateDir: directory });
  const sentinel = await writeRegistry(directory, registryFixture({ revision: 88, marker: "sentinel" }));
  const manifestPath = join(directory, MANIFEST_FILENAME);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.registry.revision = 500;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    () => unpackStateBundle({ stateDir: directory }),
    (error) => error.code === "REGISTRY_IDENTITY_MISMATCH",
  );
  assert.equal(await readFile(join(directory, "registry.json"), "utf8"), sentinel);
});

test("CLI parser accepts only one fixed state directory and rejects unsafe/unknown arguments", () => {
  const expected = resolve("state-data");
  assert.deepEqual(parseStateBundleArguments(["pack", "--state-dir", "state-data"]), {
    command: "pack",
    stateDir: expected,
  });
  assert.deepEqual(parseStateBundleArguments(["unpack", "--state-dir", "state-data"]), {
    command: "unpack",
    stateDir: expected,
  });
  assert.throws(() => parseStateBundleArguments([]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["zip", "--state-dir", "state-data"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack", "--state-dir"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack", "--state-dir", "a", "--state-dir", "b"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack", "--output", "elsewhere"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack", "--state-dir=/tmp/state"]), (error) => error.code === "INVALID_STATE_BUNDLE_INPUT");
  assert.throws(() => parseStateBundleArguments(["pack", "--state-dir", resolve("/")]), (error) => error.code === "UNSAFE_STATE_DIRECTORY");
});

test("symlinked registry paths are rejected and cannot redirect pack outside state-dir", async () => {
  const directory = await directoryFixture("oriole-state-bundle-path-");
  const outside = join(await directoryFixture("oriole-state-bundle-outside-"), "outside.json");
  await writeFile(outside, `${JSON.stringify(registryFixture())}\n`);
  await symlink(outside, join(directory, "registry.json"));
  await assert.rejects(
    () => packStateBundle({ stateDir: directory }),
    (error) => error.code === "UNSAFE_STATE_BUNDLE_PATH",
  );
});
