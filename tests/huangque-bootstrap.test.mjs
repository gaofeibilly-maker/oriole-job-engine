import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HuangqueEngine } from "../scripts/huangque/lib/engine.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);

test("a clean public clone bootstraps nine reviewed sources and zero jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-public-bootstrap-"));
  const seedManifest = JSON.parse(await readFile(join(projectRoot, "data/huangque/verified-source-seeds.json"), "utf8"));
  assert.equal(seedManifest.metadata.schemaVersion, "huangque.verified-source-seeds.v1");
  assert.equal(seedManifest.sources.length, 9);
  assert.deepEqual(seedManifest.jobs, []);

  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  });
  const bootstrapped = await engine.bootstrapExistingSources();
  const state = await engine.registry.snapshot();
  const status = await engine.status();

  assert.equal(bootstrapped.bootstrapMode, "verified_source_seeds");
  assert.equal(bootstrapped.imported, 9);
  assert.equal(bootstrapped.jobs.received, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(status.sourceCounts.approved, 9);
  assert.ok(state.sources.every((source) => source.lifecycle === "approved" && source.collectionEnabled && source.verificationState === "verified"));
  assert.ok(state.sources.every((source) => source.candidate.decision.reasonCodes.includes("VERIFIED_SOURCE_SEED")));
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  assert.equal((await engine.status()).sourceCounts.approved, 9);
  assert.ok(state.edges.length > 0);
  assert.ok(state.edges.every((edge) => edge.evidence && Object.keys(edge.evidence).length > 0));
});

test("seed bootstrap never resurrects a human rejection or safety-disabled source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-seed-tombstone-"));
  const engine = new HuangqueEngine({
    projectRoot,
    registryPath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  let sources = (await engine.listSources({})).sources;

  const rejectedSeed = sources[0];
  await engine.reviewSource({
    sourceId: rejectedSeed.id,
    decision: "reject",
    reason: "运营方明确撤销该种子来源",
    reviewedBy: "operator",
    expectedRevision: rejectedSeed.revision,
    confirmation: true,
  });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  let rejectedAfterBootstrap = (await engine.listSources({})).sources.find((source) => source.id === rejectedSeed.id);
  assert.equal(rejectedAfterBootstrap.lifecycle, "rejected");
  assert.equal(rejectedAfterBootstrap.reviewStatus, "rejected");
  assert.equal(rejectedAfterBootstrap.collectionEnabled, false);
  assert.equal(rejectedAfterBootstrap.review.decision, "reject");

  await engine.reviewSource({
    sourceId: rejectedSeed.id,
    decision: "approve",
    reason: "运营方复核后显式恢复",
    reviewedBy: "operator",
    expectedRevision: rejectedAfterBootstrap.revision,
    confirmation: true,
  });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  rejectedAfterBootstrap = (await engine.listSources({})).sources.find((source) => source.id === rejectedSeed.id);
  assert.equal(rejectedAfterBootstrap.lifecycle, "approved");
  assert.equal(rejectedAfterBootstrap.collectionEnabled, true);

  sources = (await engine.listSources({})).sources;
  const safetyDisabledSeed = sources.find((source) => source.id !== rejectedSeed.id);
  await engine.registry.recordProbe(safetyDisabledSeed.id, {
    schemaVersion: "huangque.probe.v1",
    sourceId: safetyDisabledSeed.id,
    probedAt: "2026-08-21T00:00:00.000Z",
    verificationState: "blocked_robots",
    collectable: false,
    strategy: "none",
    evidence: [{ kind: "robots", reason: "robots_disallowed" }],
    errors: [{ code: "ROBOTS_DISALLOWED", message: "robots.txt disallowed" }],
    edges: [],
    sampleJobs: [],
    counts: { total: 0, china: 0, beijing: 0 },
  });
  await engine.bootstrapExistingSources({ verifiedSeedsOnly: true });
  const disabledAfterBootstrap = (await engine.listSources({})).sources.find((source) => source.id === safetyDisabledSeed.id);
  assert.equal(disabledAfterBootstrap.lifecycle, "probed");
  assert.equal(disabledAfterBootstrap.reviewStatus, "blocked");
  assert.equal(disabledAfterBootstrap.verificationState, "blocked_robots");
  assert.equal(disabledAfterBootstrap.collectionEnabled, false);
});
