import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HuangqueEngine } from "../scripts/huangque/lib/engine.mjs";
import {
  combinedSourceSpiderStatus,
  readSourceSpiderState,
  runSourceSpider,
  selectEmployerTargets,
  SOURCE_SPIDER_STATE_SCHEMA_VERSION,
  sourceSpiderQueueSummary,
  sourceSpiderRunFingerprint,
} from "../scripts/huangque/lib/source-spider.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const checkedUniversePath = join(projectRoot, "data/huangque/employer-universe.json");
const fixedNow = new Date("2026-08-21T00:00:00.000Z");
const futureDueAt = "2099-01-01T00:00:00.000Z";

function target(id, {
  name = `用人单位 ${id}`,
  tier = "B",
  officialRecruitmentUrl = null,
  officialWebsite = null,
  aliases = [],
} = {}) {
  const officialDomains = [];
  for (const value of [officialRecruitmentUrl, officialWebsite]) {
    if (value) officialDomains.push(new URL(value).hostname);
  }
  return { id, name, aliases, tier, officialRecruitmentUrl, officialWebsite, officialDomains };
}

function emptyRegistryState({ jobs = [], sources = [] } = {}) {
  return { schemaVersion: "huangque.registry.v1", revision: 0, sources, jobs };
}

function spiderState(targets = {}) {
  return {
    schemaVersion: SOURCE_SPIDER_STATE_SCHEMA_VERSION,
    revision: 0,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    targets,
    runs: [],
  };
}

async function checkedUniverse() {
  return JSON.parse(await readFile(checkedUniversePath, "utf8"));
}

function bytedanceTarget(universe) {
  return universe.targets.find((item) => item.identifiers?.some((identifier) => (
    identifier.scheme === "curated_priority_id" && identifier.value === "priority:bytedance"
  )));
}

async function writeOnlyTargetDue(statePath, universe, selectedTargetId) {
  const targets = Object.fromEntries(universe.targets
    .filter((item) => item.id !== selectedTargetId)
    .map((item) => [item.id, { nextDueAt: futureDueAt }]));
  await writeFile(statePath, `${JSON.stringify(spiderState(targets))}\n`, "utf8");
}

function byteDanceFixtureNetwork(requestedUrls) {
  return async (url) => {
    requestedUrls.push(String(url));
    if (String(url).endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    }
    if (url === "https://jobs.bytedance.com/api/v1/csrf/token") {
      return new Response(JSON.stringify({ code: 0, data: { token: "fixture-csrf" } }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "atsx-csrf-token=fixture-cookie; Path=/; Secure",
        },
      });
    }
    if (url === "https://jobs.bytedance.com/api/v1/search/job/posts") {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          count: 1,
          job_post_list: [{ id: "fixture-job", title: "字节跳动测试工程师", city_info: { name: "北京" } }],
        },
      }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fixture URL ${url}`);
  };
}

test("5000-target queue is priority ordered and bounded to its hard per-run maximum", () => {
  const bytedance = target("priority-bytedance", {
    name: "字节跳动",
    tier: "B",
    officialRecruitmentUrl: "https://jobs.bytedance.com/",
    aliases: ["ByteDance"],
  });
  const universe = {
    targets: [
      bytedance,
      target("tier-a-unrooted", { tier: "A" }),
      target("tier-b-rooted", { tier: "B", officialWebsite: "https://example-rooted.test/" }),
      ...Array.from({ length: 4_997 }, (_, index) => target(`bulk-${String(index).padStart(4, "0")}`, { tier: "B" })),
    ],
  };
  const registry = emptyRegistryState({ jobs: [{ id: "observed-byte", company: "ByteDance" }] });
  const state = spiderState();
  const selected = selectEmployerTargets(universe, registry, state, {
    now: fixedNow,
    maxEmployers: 50_000,
  });

  assert.equal(universe.targets.length, 5_000);
  assert.equal(selected.length, 300);
  assert.equal(selected[0].target.id, bytedance.id);
  assert.equal(selected[0].score, 1_550);
  assert.equal(selected[1].target.id, "tier-a-unrooted");
  assert.ok(selected.every((item, index) => index === 0 || selected[index - 1].score >= item.score));
  assert.equal(new Set(selected.map((item) => item.target.id)).size, selected.length);

  const summary = sourceSpiderQueueSummary(universe, registry, state, fixedNow);
  assert.deepEqual(summary, { total: 5_000, approved: 0, verifiedPendingReview: 0, discovered: 0, missing: 5_000, due: 5_000, backoff: 0 });
});

test("a reviewed ByteDance recruitment root outranks an otherwise equivalent missing target", () => {
  const reviewed = target("bytedance-reviewed", {
    name: "字节跳动",
    tier: "A",
    officialRecruitmentUrl: "https://jobs.bytedance.com/",
  });
  const ordinary = target("ordinary-missing", { tier: "A" });
  const selected = selectEmployerTargets(
    { targets: [ordinary, reviewed] },
    emptyRegistryState(),
    spiderState(),
    { now: fixedNow, maxEmployers: 2 },
  );

  assert.deepEqual(selected.map((item) => item.target.id), [reviewed.id, ordinary.id]);
  assert.equal(selected[0].score - selected[1].score, 150);
  assert.equal(selected[0].target.officialRecruitmentUrl, "https://jobs.bytedance.com/");
});

test("missing spider state starts empty and a ByteDance fixture run persists backoff without approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-spider-success-"));
  const statePath = join(directory, "source-spider-state.json");
  const registryPath = join(directory, "registry.json");
  const initial = await readSourceSpiderState(statePath, fixedNow);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.targets, {});

  const universe = await checkedUniverse();
  const bytedance = bytedanceTarget(universe);
  assert.ok(bytedance, "checked-in universe must contain reviewed ByteDance");
  assert.equal(bytedance.officialRecruitmentUrl, "https://jobs.bytedance.com/");
  await writeOnlyTargetDue(statePath, universe, bytedance.id);

  const requestedUrls = [];
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath,
    artifactRoot: join(directory, "artifacts"),
    employerUniversePath: checkedUniversePath,
    sourceSpiderStatePath: statePath,
    now: () => fixedNow,
    fetchOptions: { fetchImpl: byteDanceFixtureNetwork(requestedUrls), skipDns: true },
  });
  const report = await runSourceSpider(engine, {
    universePath: checkedUniversePath,
    statePath,
    maxEmployers: 1,
    maxProbes: 1,
    maxCrawlPages: 1,
    providers: [],
  });

  assert.equal(report.status, "completed_with_findings");
  assert.equal(report.timezone, "Asia/Shanghai");
  assert.equal(report.scheduledDate, "2026-08-21");
  assert.equal(report.onlineEvidence.present, true);
  assert.equal(report.onlineEvidence.verifiedProbes, 1);
  assert.deepEqual(report.selectedTargetIds, [bytedance.id]);
  assert.match(report.approvalBoundary, /不能自动进入 approved/);
  assert.ok(requestedUrls.length >= 3, JSON.stringify({ requestedUrls, probes: report.probes, discovery: report.discovery }));
  assert.ok(requestedUrls.every((url) => url.startsWith("https://jobs.bytedance.com/")));

  const registry = await engine.registry.snapshot();
  const source = registry.sources.find((item) => item.candidate?.provider === "ByteDance");
  assert.ok(source, "fixture run must discover the reviewed ByteDance root");
  assert.equal(source.candidate.sourceRootUrl, "https://jobs.bytedance.com/experienced/position");
  assert.equal(source.lifecycle, "probed");
  assert.equal(source.verificationState, "verified");
  assert.equal(source.reviewStatus, "pending");
  assert.equal(source.collectionEnabled, false);
  assert.equal(registry.sources.some((item) => item.lifecycle === "approved"), false);
  assert.equal(registry.jobs.length, 0);

  const persisted = await readSourceSpiderState(statePath, fixedNow);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.targets[bytedance.id].attempts, 1);
  assert.equal(persisted.targets[bytedance.id].consecutiveFailures, 0);
  assert.equal(persisted.targets[bytedance.id].lastSuccessAt, fixedNow.toISOString());
  assert.equal(persisted.targets[bytedance.id].nextDueAt, "2026-08-28T00:00:00.000Z");
  assert.ok(persisted.targets[bytedance.id].frontier.some((item) => item.url === "https://jobs.bytedance.com/"));
  assert.equal(persisted.targets[bytedance.id].visitedUrls.includes("https://jobs.bytedance.com/"), false);
  assert.equal(persisted.runs[0].status, "completed_with_findings");
});

test("concurrent spider instances cannot overwrite the same persistent queue state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-spider-lock-"));
  const statePath = join(directory, "source-spider-state.json");
  const universe = await checkedUniverse();
  const bytedance = bytedanceTarget(universe);
  await writeOnlyTargetDue(statePath, universe, bytedance.id);
  const fixture = byteDanceFixtureNetwork([]);
  let releaseNetwork;
  let enteredNetwork;
  const entered = new Promise((resolveEntered) => { enteredNetwork = resolveEntered; });
  const gate = new Promise((resolveGate) => { releaseNetwork = resolveGate; });
  let firstRequest = true;
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "registry.json"),
    artifactRoot: join(directory, "artifacts"),
    employerUniversePath: checkedUniversePath,
    sourceSpiderStatePath: statePath,
    now: () => fixedNow,
    fetchOptions: {
      fetchImpl: async (url, options) => {
        if (firstRequest) {
          firstRequest = false;
          enteredNetwork();
          await gate;
        }
        return fixture(url, options);
      },
      skipDns: true,
    },
  });
  const options = {
    universePath: checkedUniversePath,
    statePath,
    maxEmployers: 1,
    maxProbes: 1,
    maxCrawlPages: 1,
    providers: [],
  };
  const first = runSourceSpider(engine, options);
  await entered;
  try {
    await assert.rejects(
      () => runSourceSpider(engine, { ...options, lockTimeoutMs: 40 }),
      (error) => error.code === "SOURCE_SPIDER_LOCK_TIMEOUT",
    );
  } finally {
    releaseNetwork();
  }
  await first;
  const persisted = await readSourceSpiderState(statePath, fixedNow);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.runs.length, 1);
  await assert.rejects(() => readFile(`${statePath}.lock`), (error) => error.code === "ENOENT");
});

test("provider failure is reported as failed and persists exponential retry state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-spider-failure-"));
  const statePath = join(directory, "source-spider-state.json");
  const universe = await checkedUniverse();
  const noRoot = universe.targets.find((item) => !item.officialRecruitmentUrl && !item.officialWebsite);
  assert.ok(noRoot, "fixture requires at least one directory target without a reviewed web root");
  await writeOnlyTargetDue(statePath, universe, noRoot.id);

  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "registry.json"),
    artifactRoot: join(directory, "artifacts"),
    employerUniversePath: checkedUniversePath,
    sourceSpiderStatePath: statePath,
    now: () => fixedNow,
    fetchOptions: {
      fetchImpl: async (url) => { throw new Error(`real network forbidden in fixture: ${url}`); },
      skipDns: true,
    },
  });
  const report = await runSourceSpider(engine, {
    universePath: checkedUniversePath,
    statePath,
    maxEmployers: 1,
    maxProbes: 0,
    maxCrawlPages: 0,
    providers: ["fixture_failure"],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.onlineEvidence.present, false);
  assert.deepEqual(report.selectedTargetIds, [noRoot.id]);
  assert.equal(report.providerRuns.length, 1);
  assert.equal(report.providerRuns[0].provider, "fixture_failure");
  assert.equal(report.providerRuns[0].status, "failed");
  assert.equal(report.probes.length, 0);
  const registryRun = await engine.getRun(report.runId);
  assert.equal(registryRun.status, "failed");

  const persisted = await readSourceSpiderState(statePath, fixedNow);
  assert.equal(persisted.targets[noRoot.id].attempts, 1);
  assert.equal(persisted.targets[noRoot.id].consecutiveFailures, 1);
  assert.equal(persisted.targets[noRoot.id].lastSuccessAt, null);
  assert.equal(persisted.targets[noRoot.id].nextDueAt, "2026-08-22T00:00:00.000Z");
  assert.equal(persisted.runs[0].status, "failed");
});

test("an imported reviewed root alone is never laundered into online spider success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "huangque-source-spider-imported-only-"));
  const statePath = join(directory, "source-spider-state.json");
  const universe = await checkedUniverse();
  const bytedance = bytedanceTarget(universe);
  await writeOnlyTargetDue(statePath, universe, bytedance.id);
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "registry.json"),
    artifactRoot: join(directory, "artifacts"),
    employerUniversePath: checkedUniversePath,
    sourceSpiderStatePath: statePath,
    now: () => fixedNow,
    fetchOptions: { fetchImpl: async () => { throw new Error("network disabled"); }, skipDns: true },
  });
  const report = await runSourceSpider(engine, {
    universePath: checkedUniversePath,
    statePath,
    maxEmployers: 1,
    maxProbes: 0,
    maxCrawlPages: 0,
    providers: ["fixture_failure"],
  });
  assert.equal(report.providerRuns.some((run) => run.provider === "imported" && run.status === "ok"), true);
  assert.equal(report.onlineEvidence.present, false);
  assert.equal(report.status, "failed");
  const persisted = await readSourceSpiderState(statePath, fixedNow);
  assert.equal(persisted.targets[bytedance.id].lastSuccessAt, null);
  assert.equal(persisted.targets[bytedance.id].consecutiveFailures, 1);
});

test("source-spider run fingerprint is deterministic and content sensitive", () => {
  const report = {
    schemaVersion: "huangque.source-spider-run.v1",
    runId: "run-fixture",
    completedAt: "2026-08-21T00:00:00.000Z",
    status: "completed_with_findings",
    selectedTargetIds: ["bytedance"],
  };
  const first = sourceSpiderRunFingerprint(report);
  const second = sourceSpiderRunFingerprint(structuredClone(report));
  const changed = sourceSpiderRunFingerprint({ ...report, status: "failed" });

  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("deep regional discovery cannot be hidden behind a successful employer crawl", () => {
  assert.equal(combinedSourceSpiderStatus("completed_with_findings", { status: "partial" }), "partial");
  assert.equal(combinedSourceSpiderStatus("completed_with_findings", { status: "failed" }), "partial");
  assert.equal(combinedSourceSpiderStatus("completed_with_findings", { status: "completed" }), "completed_with_findings");
  assert.equal(combinedSourceSpiderStatus("failed", { status: "completed" }), "failed");
  assert.equal(combinedSourceSpiderStatus(undefined, null), "failed");
});
