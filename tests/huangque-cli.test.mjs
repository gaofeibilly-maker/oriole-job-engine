import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { huangqueToolResultOutcome } from "../scripts/huangque/lib/agent-tools.mjs";
import { JsonRegistry } from "../scripts/huangque/lib/registry.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(projectRoot, "scripts/huangque/cli.mjs");

async function runCli(arguments_, { env = {}, setup = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "huangque-cli-"));
  const registryPath = join(directory, "state.json");
  const artifactRoot = join(directory, "artifacts");
  if (setup) await setup({ directory, registryPath, artifactRoot });
  const child = spawn(process.execPath, [cliPath, ...arguments_, "--registry", registryPath, "--artifact-root", artifactRoot], {
    cwd: projectRoot,
    env: { ...process.env, ...env, HUANGQUE_BAIDU_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once("exit", resolveExit));
  return { registryPath, exitCode, stdout, stderr };
}

test("CLI explicit false never enables commit", async () => {
  for (const flag of [["--commit", "false"], ["--commit=false"]]) {
    const result = await runCli(["collect", ...flag]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commit, false);
  }
});

test("CLI bare and explicit true preserve intentional commit opt-in", async () => {
  for (const flag of [["--commit"], ["--commit", "true"], ["--commit=true"]]) {
    const result = await runCli(["collect", ...flag]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commit, true);
  }
});

test("CLI explicit false never satisfies human review confirmation", async () => {
  for (const flag of [["--confirm", "false"], ["--confirm=false"]]) {
    const result = await runCli([
      "review",
      "--source", "missing-source",
      "--decision", "reject",
      "--reason", "审计拒绝",
      "--reviewer", "tester",
      "--revision", "1",
      ...flag,
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\[CONFIRMATION_REQUIRED\]/);
  }
});

test("CLI explicit false reaches discovery as force=false and collect-approved=false", async () => {
  const result = await runCli([
    "pipeline",
    "--providers", "official_catalog",
    "--buckets", "national-official",
    "--max-queries", "1",
    "--max-probes", "0",
    "--force", "false",
    "--collect-approved", "false",
    "--commit", "false",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).collection, null);
  const state = JSON.parse(await readFile(result.registryPath, "utf8"));
  const discoveryRun = state.runs.find((run) => run.kind === "discovery");
  assert.equal(discoveryRun.input.force, false);
});

test("CLI and Agent fail closed for unsuccessful or structurally unknown execution outcomes", async () => {
  for (const command of ["discover", "pipeline"]) {
    const result = await runCli([
      command,
      "--providers", "baidu",
      "--buckets", "national-official",
      "--max-queries", "1",
      ...(command === "pipeline" ? ["--max-probes", "0"] : []),
    ]);
    assert.equal(result.exitCode, 1, `${command} unexpectedly exited successfully: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).status, "failed");
  }

  const collection = await runCli(["collect"], {
    setup: async ({ registryPath }) => {
      const registry = new JsonRegistry(registryPath);
      await registry.importApprovedSource({
        id: "unreachable-cli-fixture",
        sourceKey: "ats:greenhouse:unreachable-cli-fixture",
        name: "Unreachable CLI fixture",
        publisher: "Fixture",
        provider: "Greenhouse",
        tenant: "unreachable-cli-fixture",
        sourceType: "official_ats",
        sourceRootUrl: "https://oriole-cli-fixture.invalid/jobs",
        publicApiUrl: "https://oriole-cli-fixture.invalid/api/jobs",
      });
    },
  });
  assert.equal(collection.exitCode, 1, `collect unexpectedly exited successfully: ${collection.stdout}`);
  assert.equal(JSON.parse(collection.stdout).stats.sourcesFailed, 1);

  const universePath = join(projectRoot, "data/huangque/employer-universe.json");
  const universe = JSON.parse(await readFile(universePath, "utf8"));
  const unrootedTarget = universe.targets.find((target) => !target.officialRecruitmentUrl && !target.officialWebsite);
  assert.ok(unrootedTarget, "fixture universe must retain at least one employer awaiting root discovery");
  const spiderDirectory = await mkdtemp(join(tmpdir(), "huangque-cli-spider-"));
  const spiderStatePath = join(spiderDirectory, "source-spider-state.json");
  const futureDueAt = "2099-01-01T00:00:00.000Z";
  await writeFile(spiderStatePath, `${JSON.stringify({
    schemaVersion: "huangque.source-spider-state.v1",
    revision: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    targets: Object.fromEntries(universe.targets
      .filter((target) => target.id !== unrootedTarget.id)
      .map((target) => [target.id, { nextDueAt: futureDueAt }])),
    runs: [],
  })}\n`, "utf8");
  const spider = await runCli([
    "source-spider", "--max-employers", "1", "--max-probes", "0", "--max-crawl-pages", "0",
  ], { env: { HUANGQUE_EMPLOYER_UNIVERSE_PATH: universePath, HUANGQUE_SOURCE_SPIDER_STATE_PATH: spiderStatePath } });
  assert.equal(spider.exitCode, 1, `source-spider unexpectedly exited successfully: ${spider.stdout}`);
  assert.equal(JSON.parse(spider.stdout).status, "failed");

  assert.deepEqual(huangqueToolResultOutcome("huangque.run_source_spider", { status: "partial" }), {
    completed: false, isError: true, status: "partial",
  });
  assert.deepEqual(huangqueToolResultOutcome("huangque.run_source_spider", { status: "unexpected_status" }), {
    completed: false, isError: true, status: "unexpected_status",
  });
  assert.deepEqual(huangqueToolResultOutcome("huangque.collect_jobs", null), {
    completed: false, isError: true, status: "unknown",
  });
  assert.deepEqual(huangqueToolResultOutcome("huangque.collect_jobs", {}), {
    completed: false, isError: true, status: "unknown",
  });
});

test("CLI rejects non-boolean values for safety flags", async () => {
  const result = await runCli(["collect", "--commit", "maybe"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /\[INVALID_BOOLEAN\]/);
});

test("daily runner replaces a corrupt latest marker with an explicit receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-daily-corrupt-"));
  const runtimeRoot = join(directory, "state-data");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "latest-job-update.json"), "{not-json\n", "utf8");
  const child = spawn(process.execPath, [join(projectRoot, "scripts/huangque/daily-update.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HUANGQUE_BAIDU_API_KEY: "",
      HUANGQUE_RUNTIME_ROOT: runtimeRoot,
      HUANGQUE_REGISTRY_PATH: join(runtimeRoot, "registry.json"),
      HUANGQUE_ARTIFACT_ROOT: join(directory, "artifacts"),
      HUANGQUE_EMPLOYER_UNIVERSE_PATH: join(projectRoot, "data/huangque/employer-universe.json"),
      HUANGQUE_DAILY_MAX_COLLECTIONS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(exitCode, 0, stderr);
  const receipt = JSON.parse(await readFile(join(runtimeRoot, "latest-job-update.json"), "utf8"));
  assert.equal(receipt.status, "no_work");
  assert.equal(receipt.warnings[0].kind, "previous_receipt_invalid");
  assert.match(receipt.warnings[0].message, /JSON/);
});
