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
