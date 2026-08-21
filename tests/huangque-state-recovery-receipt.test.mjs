import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  createStateRecoveryReceipt,
  parseStateRecoveryArguments,
  STATE_RECOVERY_SCHEMA_VERSION,
} from "../scripts/huangque/state-recovery-receipt.mjs";
import { packStateBundle } from "../scripts/huangque/state-bundle.mjs";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const checkedUniversePath = join(projectRoot, "data/huangque/employer-universe.json");
let checkedUniverseBytes;

function registryFixture({ revision = 7, jobs = [{ id: "one" }, { id: "two" }] } = {}) {
  return {
    schemaVersion: "huangque.registry.v1",
    revision,
    sources: [{ id: "approved", lifecycle: "approved" }, { id: "candidate", lifecycle: "candidate" }],
    jobs,
    edges: [{ id: "edge" }],
    runs: [{ id: "run" }],
  };
}

function statusFixture(registry, overrides = {}) {
  return {
    schemaVersion: "huangque.status.v1",
    registryRevision: registry.revision,
    sourceCounts: { candidate: 1, probed: 0, approved: 1, rejected: 0 },
    jobs: registry.jobs.length,
    graphEdges: registry.edges.length,
    runs: registry.runs.length,
    ...overrides,
  };
}

function githubFixture(overrides = {}) {
  return {
    repository: "oriole/example",
    workflow: "Oriole state recovery audit",
    runId: "123456789",
    runAttempt: "2",
    runNumber: "45",
    commitSha: "a".repeat(40),
    stateCommitSha: "b".repeat(40),
    ref: "refs/heads/main",
    eventName: "workflow_dispatch",
    ...overrides,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, body);
  return body;
}

async function recoveryFixture({ receipts = true, previousReceipt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "oriole-recovery-v2-"));
  const sourceStateDir = join(root, "source-state-data");
  const restoredStateDir = join(root, "isolated", "state-data");
  const statusReportPath = join(root, "isolated", "status.json");
  const outputPath = join(sourceStateDir, "latest-state-recovery.json");
  await mkdir(sourceStateDir, { recursive: true });
  const registry = registryFixture();
  const registryBody = await writeJson(join(sourceStateDir, "registry.json"), registry);
  const bundleManifest = await packStateBundle({
    stateDir: sourceStateDir,
    packedAt: "2026-08-21T11:00:00.000Z",
  });
  await unlink(join(sourceStateDir, "registry.json"));
  checkedUniverseBytes ??= await readFile(checkedUniversePath);
  await writeFile(join(sourceStateDir, "employer-universe.json"), checkedUniverseBytes);
  await writeJson(join(sourceStateDir, "source-spider-state.json"), {
    schemaVersion: "huangque.source-spider-state.v1",
    revision: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    targets: { "employer-one": { attempts: 1 } },
    runs: [{ id: "spider-run" }],
  });
  await writeJson(join(sourceStateDir, "job-updates", "2026-08-20.json"), {
    schemaVersion: "huangque.job-update-receipt.v1",
    status: "completed",
  });
  if (receipts) {
    await writeJson(join(sourceStateDir, "latest-job-update.json"), {
      schemaVersion: "huangque.job-update-receipt.v1",
      status: "completed",
      completedAt: "2026-08-21T08:00:00.000Z",
    });
    await writeJson(join(sourceStateDir, "latest-source-spider.json"), {
      schemaVersion: "huangque.source-spider-run.v1",
      status: "completed_with_findings",
      completedAt: "2026-08-21T10:00:00.000Z",
    });
  }
  if (previousReceipt) await writeFile(outputPath, "{\"schemaVersion\":\"previous-success\"}\n");
  await cp(sourceStateDir, restoredStateDir, { recursive: true });
  await writeJson(statusReportPath, statusFixture(registry));
  return {
    root,
    sourceStateDir,
    restoredStateDir,
    statusReportPath,
    outputPath,
    registry,
    registryBody,
    bundleManifest,
  };
}

function receiptInput(fixture, overrides = {}) {
  return {
    sourceStateDir: fixture.sourceStateDir,
    restoredStateDir: fixture.restoredStateDir,
    statusReportPath: fixture.statusReportPath,
    outputPath: fixture.outputPath,
    github: githubFixture(),
    completedAt: "2026-08-21T12:34:56.000Z",
    ...overrides,
  };
}

test("v2 recovery verifies the bundle and every durable state file before writing its receipt", async () => {
  const fixture = await recoveryFixture();
  const receipt = await createStateRecoveryReceipt(receiptInput(fixture));

  assert.equal(receipt.schemaVersion, STATE_RECOVERY_SCHEMA_VERSION);
  assert.equal(receipt.schemaVersion, "huangque.state-recovery.v2");
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.trigger, "github_actions");
  assert.equal(receipt.completedAt, "2026-08-21T12:34:56.000Z");
  assert.equal(receipt.github.runId, "123456789");
  assert.equal(receipt.github.stateCommitSha, "b".repeat(40));
  assert.equal(receipt.registryBundle.manifest.schemaVersion, "huangque.state-bundle-manifest.v1");
  assert.equal(receipt.registryBundle.compressed.sha256, fixture.bundleManifest.bundle.sha256);
  assert.equal(receipt.registryBundle.compressed.bytes, fixture.bundleManifest.bundle.bytes);
  assert.equal(receipt.registryBundle.restoredRegistry.revision, 7);
  assert.equal(receipt.registryBundle.restoredRegistry.persistedInSourceBranch, false);
  assert.equal(await readFile(join(fixture.restoredStateDir, "registry.json"), "utf8"), fixture.registryBody);
  await assert.rejects(() => readFile(join(fixture.sourceStateDir, "registry.json")), (error) => error.code === "ENOENT");

  assert.equal(receipt.stateInventory.matched, true);
  assert.deepEqual(receipt.stateInventory.source, receipt.stateInventory.restored);
  assert.ok(receipt.stateInventory.files.some((entry) => entry.path === "job-updates/2026-08-20.json"));
  assert.ok(receipt.stateInventory.files.some((entry) => entry.path === "registry.json.gz"));
  assert.ok(!receipt.stateInventory.files.some((entry) => entry.path === "registry.json"));
  assert.equal(receipt.employerUniverse.schemaVersion, "huangque.employer-universe.v1");
  assert.equal(receipt.employerUniverse.complete, true);
  assert.ok(receipt.employerUniverse.targets >= 5_000);
  assert.equal(receipt.sourceSpiderState.schemaVersion, "huangque.source-spider-state.v1");
  assert.equal(receipt.sourceSpiderState.revision, 3);
  assert.equal(receipt.latestReceipts.jobUpdate.present, true);
  assert.equal(receipt.latestReceipts.jobUpdate.status, "completed");
  assert.equal(receipt.latestReceipts.sourceSpider.present, true);
  assert.equal(receipt.latestReceipts.sourceSpider.status, "completed_with_findings");
  assert.deepEqual(receipt.agentStatus.summary, {
    registryRevision: 7,
    sources: 2,
    sourceCounts: { candidate: 1, probed: 0, approved: 1, rejected: 0 },
    jobs: 2,
    graphEdges: 1,
    runs: 1,
  });
  assert.deepEqual(receipt.verification, {
    registryBundleVerified: true,
    completeInventoryMatched: true,
    employerUniverseValid: true,
    sourceSpiderStateValid: true,
    optionalLatestReceiptsValid: true,
    statusMatchedRegistry: true,
    sourcePlaintextRegistryAbsent: true,
    transientStateFilesAbsent: true,
  });
  assert.deepEqual(JSON.parse(await readFile(fixture.outputPath, "utf8")), receipt);
});

test("optional latest job and spider receipts are recorded as absent without weakening other checks", async () => {
  const fixture = await recoveryFixture({ receipts: false });
  const receipt = await createStateRecoveryReceipt(receiptInput(fixture));
  assert.deepEqual(receipt.latestReceipts.jobUpdate, {
    present: false,
    artifact: "state-data/latest-job-update.json",
  });
  assert.deepEqual(receipt.latestReceipts.sourceSpider, {
    present: false,
    artifact: "state-data/latest-source-spider.json",
  });
  assert.equal(receipt.verification.optionalLatestReceiptsValid, true);
});

test("tampered bundle fails inside unpack and never replaces the previous successful receipt", async () => {
  const fixture = await recoveryFixture({ previousReceipt: true });
  const previous = await readFile(fixture.outputPath, "utf8");
  const bundlePath = join(fixture.restoredStateDir, "registry.json.gz");
  await writeFile(bundlePath, Buffer.concat([await readFile(bundlePath), Buffer.from("tampered")]));
  await assert.rejects(
    () => createStateRecoveryReceipt(receiptInput(fixture)),
    (error) => error.code === "BUNDLE_HASH_MISMATCH",
  );
  assert.equal(await readFile(fixture.outputPath, "utf8"), previous);
});

test("complete inventory mismatch fails before overwriting an older receipt", async () => {
  const fixture = await recoveryFixture({ previousReceipt: true });
  const previous = await readFile(fixture.outputPath, "utf8");
  await writeFile(join(fixture.restoredStateDir, "job-updates", "2026-08-20.json"), "changed\n");
  await assert.rejects(
    () => createStateRecoveryReceipt(receiptInput(fixture)),
    (error) => error.code === "RECOVERY_INVENTORY_MISMATCH",
  );
  assert.equal(await readFile(fixture.outputPath, "utf8"), previous);
});

test("invalid required state and mismatched Agent status fail closed", async (t) => {
  await t.test("employer universe", async () => {
    const fixture = await recoveryFixture({ previousReceipt: true });
    const previous = await readFile(fixture.outputPath, "utf8");
    const invalid = "{\"schemaVersion\":\"wrong\"}\n";
    await writeFile(join(fixture.sourceStateDir, "employer-universe.json"), invalid);
    await writeFile(join(fixture.restoredStateDir, "employer-universe.json"), invalid);
    await assert.rejects(
      () => createStateRecoveryReceipt(receiptInput(fixture)),
      (error) => error.code === "RECOVERY_EMPLOYER_UNIVERSE_INVALID",
    );
    assert.equal(await readFile(fixture.outputPath, "utf8"), previous);
  });

  await t.test("source spider state", async () => {
    const fixture = await recoveryFixture({ previousReceipt: true });
    const previous = await readFile(fixture.outputPath, "utf8");
    const invalid = "{\"schemaVersion\":\"wrong\"}\n";
    await writeFile(join(fixture.sourceStateDir, "source-spider-state.json"), invalid);
    await writeFile(join(fixture.restoredStateDir, "source-spider-state.json"), invalid);
    await assert.rejects(
      () => createStateRecoveryReceipt(receiptInput(fixture)),
      (error) => error.code === "RECOVERY_SOURCE_SPIDER_STATE_INVALID",
    );
    assert.equal(await readFile(fixture.outputPath, "utf8"), previous);
  });

  await t.test("Agent status", async () => {
    const fixture = await recoveryFixture({ previousReceipt: true });
    const previous = await readFile(fixture.outputPath, "utf8");
    await writeJson(fixture.statusReportPath, statusFixture(fixture.registry, { jobs: 999 }));
    await assert.rejects(
      () => createStateRecoveryReceipt(receiptInput(fixture)),
      (error) => error.code === "RECOVERY_STATUS_MISMATCH",
    );
    assert.equal(await readFile(fixture.outputPath, "utf8"), previous);
  });
});

test("source state refuses plaintext Registry, transient files, and overlapping recovery paths", async () => {
  const fixture = await recoveryFixture();
  await writeJson(join(fixture.sourceStateDir, "registry.json"), fixture.registry);
  await assert.rejects(
    () => createStateRecoveryReceipt(receiptInput(fixture)),
    (error) => error.code === "PLAINTEXT_REGISTRY_PERSISTED",
  );
  await assert.rejects(
    () => createStateRecoveryReceipt(receiptInput(fixture, {
      restoredStateDir: join(fixture.sourceStateDir, "nested"),
    })),
    (error) => error.code === "RECOVERY_PATHS_NOT_DISTINCT",
  );

  const transientFixture = await recoveryFixture();
  await writeFile(join(transientFixture.sourceStateDir, "orphan.lock"), "lock\n");
  await writeFile(join(transientFixture.restoredStateDir, "orphan.lock"), "lock\n");
  await assert.rejects(
    () => createStateRecoveryReceipt(receiptInput(transientFixture)),
    (error) => error.code === "RECOVERY_TRANSIENT_STATE_FILE",
  );
});

function validCliArguments() {
  return [
    "--source-state-dir", "/tmp/source-state",
    "--restored-state-dir", "/tmp/restored-state",
    "--status-report", "/tmp/status.json",
    "--output", "/tmp/source-state/latest-state-recovery.json",
    "--repository", "oriole/example",
    "--workflow", "Recovery",
    "--run-id", "123",
    "--run-attempt", "1",
    "--run-number", "2",
    "--commit-sha", "a".repeat(40),
    "--state-commit-sha", "b".repeat(40),
    "--ref", "refs/heads/main",
    "--event-name", "workflow_dispatch",
  ];
}

test("v2 CLI parser requires every input and rejects unknown or duplicate values", () => {
  const parsed = parseStateRecoveryArguments(validCliArguments());
  assert.equal(parsed.sourceStateDir, "/tmp/source-state");
  assert.equal(parsed.restoredStateDir, "/tmp/restored-state");
  assert.throws(() => parseStateRecoveryArguments([]), (error) => error.code === "INVALID_RECOVERY_INPUT");
  assert.throws(() => parseStateRecoveryArguments(["--unknown", "value"]), (error) => error.code === "INVALID_RECOVERY_INPUT");
  assert.throws(
    () => parseStateRecoveryArguments([...validCliArguments(), "--output", "again"]),
    (error) => error.code === "INVALID_RECOVERY_INPUT",
  );
  assert.throws(
    () => parseStateRecoveryArguments(validCliArguments().filter((_, index) => index !== 0 && index !== 1)),
    (error) => error.code === "INVALID_RECOVERY_INPUT",
  );
});

test("recovery workflow copies all state, unpacks only in isolation, and force-with-lease replaces history with one root", async () => {
  const workflow = await readFile(new URL("../.github/workflows/state-recovery-audit.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\s+[\s\S]*?group: oriole-state-writer\s+[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s+contents: write/);
  assert.match(workflow, /cp -a [^\n]*state-data\/\.[^\n]*oriole-recovery[^\n]*state-data/);
  assert.match(workflow, /state-bundle\.mjs unpack --state-dir/);
  assert.match(workflow, /npm run --silent status/);
  assert.match(workflow, /--source-state-dir/);
  assert.match(workflow, /--restored-state-dir/);
  assert.match(workflow, /state\/state-data\/latest-state-recovery\.json/);
  assert.match(workflow, /test ! -e state-data\/registry\.json/);
  assert.match(workflow, /\*\.lock/);
  assert.match(workflow, /\*\.tmp/);
  assert.match(workflow, /\*\.backup/);
  assert.match(workflow, /git add -- state-data\/latest-state-recovery\.json/);
  assert.doesNotMatch(workflow, /git add -A -- state-data/);
  assert.match(workflow, /ORIOLE_STATE_EXPECTED_SHA/);
  assert.match(workflow, /--state-commit-sha "\$\{ORIOLE_STATE_EXPECTED_SHA\}"/);
  assert.match(workflow, /git write-tree/);
  assert.match(workflow, /git commit-tree/);
  assert.match(workflow, /--force-with-lease=refs\/heads\/oriole-state:/);
  assert.match(workflow, /git push [^\n]*refs\/heads\/oriole-state/);
  assert.doesNotMatch(workflow, /Persist receipt and compact[^\n]*\n\s+if:\s*always\(\)/);
  assert.ok(workflow.indexOf("git push --force-with-lease") < workflow.indexOf("Upload recovery evidence"));
  assert.doesNotMatch(workflow, /upload-artifact[\s\S]*?registry\.json(?:\s|$)/);
});
