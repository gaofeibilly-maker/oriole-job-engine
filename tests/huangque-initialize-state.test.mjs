import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  initializeState,
  parseInitializeStateArguments,
  STATE_INITIALIZATION_SUMMARY_SCHEMA_VERSION,
} from "../scripts/huangque/initialize-state.mjs";
import { validateSourceSpiderState } from "../scripts/huangque/lib/source-spider.mjs";
import { unpackStateBundle } from "../scripts/huangque/state-bundle.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const fixedNow = "2026-08-21T15:00:00.000Z";
const execFileAsync = promisify(execFile);
const expectedFiles = [
  "employer-universe.json",
  "registry.bundle-manifest.json",
  "registry.json.gz",
  "source-spider-state.json",
];

async function seedFacts() {
  return JSON.parse(await readFile(join(projectRoot, "data/huangque/verified-source-seeds.json"), "utf8"));
}

async function doesNotExist(path) {
  await assert.rejects(() => lstat(path), (error) => error.code === "ENOENT");
}

test("one-time initialization creates only clean durable state and a restorable Registry bundle", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oriole-initialize-state-"));
  const output = join(parent, "state-data");
  const facts = await seedFacts();
  const summary = await initializeState({ output, now: new Date(fixedNow) });

  assert.equal(summary.schemaVersion, STATE_INITIALIZATION_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.status, "completed");
  assert.equal(summary.initializedAt, fixedNow);
  assert.equal(summary.registry.seededSources, facts.sources.length);
  assert.equal(summary.registry.approvedVerifiedSources, facts.sources.length);
  assert.equal(summary.registry.jobs, 0);
  assert.equal(summary.registry.runs, 0);
  assert.equal(summary.registry.plaintextPersisted, false);
  assert.equal(summary.receiptsCreated, 0);
  assert.ok(facts.sources.length > 0);
  assert.deepEqual(facts.jobs, []);
  assert.deepEqual((await readdir(output)).sort(), expectedFiles);
  await doesNotExist(join(output, "registry.json"));
  assert.ok(!(await readdir(output)).some((name) => /receipt|latest-job|latest-source/i.test(name)));

  const checkedUniverse = await readFile(join(projectRoot, "data/huangque/employer-universe.json"));
  assert.deepEqual(await readFile(join(output, "employer-universe.json")), checkedUniverse);
  const spider = validateSourceSpiderState(JSON.parse(await readFile(join(output, "source-spider-state.json"), "utf8")));
  assert.deepEqual(spider, {
    schemaVersion: "huangque.source-spider-state.v1",
    revision: 0,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    targets: {},
    runs: [],
  });

  const manifest = await unpackStateBundle({ stateDir: output });
  assert.deepEqual(manifest, summary.bundle);
  const registry = JSON.parse(await readFile(join(output, "registry.json"), "utf8"));
  assert.equal(registry.schemaVersion, "huangque.registry.v1");
  assert.equal(registry.sources.length, facts.sources.length);
  assert.equal(registry.sources.filter((source) => source.lifecycle === "approved"
    && source.reviewStatus === "approved"
    && source.verificationState === "verified"
    && source.collectionEnabled).length, facts.sources.length);
  assert.ok(registry.sources.every((source) => source.candidate.decision.reasonCodes.includes("VERIFIED_SOURCE_SEED")));
  assert.deepEqual(registry.jobs, []);
  assert.deepEqual(registry.jobVersions, []);
  assert.deepEqual(registry.runs, []);
  assert.equal(Object.keys(registry).some((key) => /receipt/i.test(key)), false);
});

test("an existing empty real directory is accepted and committed without plaintext Registry", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oriole-initialize-empty-"));
  const output = join(parent, "state-data");
  await mkdir(output);
  const summary = await initializeState({ output, now: fixedNow });
  assert.equal(summary.output, output);
  assert.deepEqual((await readdir(output)).sort(), expectedFiles);
  await doesNotExist(join(output, "registry.json"));
});

test("the CLI emits exactly one machine-readable completion summary", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oriole-initialize-cli-"));
  const output = join(parent, "state-data");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(projectRoot, "scripts/huangque/initialize-state.mjs"),
    "--output",
    output,
  ], { cwd: projectRoot });
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.schemaVersion, STATE_INITIALIZATION_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.status, "completed");
  assert.equal(summary.output, output);
  assert.equal(summary.receiptsCreated, 0);
  assert.deepEqual((await readdir(output)).sort(), expectedFiles);
});

test("unsafe CLI inputs, roots, duplicate flags and symlink outputs are rejected", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oriole-initialize-unsafe-"));
  const realDirectory = join(parent, "real");
  const linkedOutput = join(parent, "linked");
  await mkdir(realDirectory);
  await symlink(realDirectory, linkedOutput);

  assert.throws(() => parseInitializeStateArguments([]), (error) => error.code === "INVALID_STATE_INITIALIZATION_INPUT");
  assert.throws(() => parseInitializeStateArguments(["--unknown", "x"]), (error) => error.code === "INVALID_STATE_INITIALIZATION_INPUT");
  assert.throws(() => parseInitializeStateArguments(["--output", "a", "--output", "b"]), (error) => error.code === "INVALID_STATE_INITIALIZATION_INPUT");
  assert.throws(() => parseInitializeStateArguments(["--output=x"]), (error) => error.code === "INVALID_STATE_INITIALIZATION_INPUT");
  assert.throws(() => parseInitializeStateArguments(["--output", parsePath(resolve("/")).root]), (error) => error.code === "UNSAFE_STATE_OUTPUT");
  await assert.rejects(() => initializeState({ output: linkedOutput }), (error) => error.code === "UNSAFE_STATE_OUTPUT");
  const missingParent = join(parent, "missing-parent");
  await assert.rejects(() => initializeState({ output: join(missingParent, "state-data") }), (error) => error.code === "UNSAFE_STATE_OUTPUT");
  await doesNotExist(missingParent);
  assert.deepEqual(await readdir(realDirectory), []);
});

test("nonempty outputs and build failures preserve the caller's directory byte-for-byte", async () => {
  const parent = await mkdtemp(join(tmpdir(), "oriole-initialize-preserve-"));
  const nonempty = join(parent, "nonempty");
  const sentinelPath = join(nonempty, "sentinel.txt");
  await mkdir(nonempty);
  await writeFile(sentinelPath, "keep-me\n");
  await assert.rejects(() => initializeState({ output: nonempty }), (error) => error.code === "STATE_OUTPUT_NOT_EMPTY");
  assert.equal(await readFile(sentinelPath, "utf8"), "keep-me\n");
  assert.deepEqual(await readdir(nonempty), ["sentinel.txt"]);

  const empty = join(parent, "empty");
  await mkdir(empty);
  await assert.rejects(
    () => initializeState({
      output: empty,
      now: fixedNow,
      packStateBundleImpl: async () => { throw Object.assign(new Error("injected pack failure"), { code: "INJECTED_PACK_FAILURE" }); },
    }),
    (error) => error.code === "INJECTED_PACK_FAILURE",
  );
  assert.deepEqual(await readdir(empty), []);
});
