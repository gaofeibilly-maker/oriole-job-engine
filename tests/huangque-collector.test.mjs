import assert from "node:assert/strict";
import test from "node:test";
import { collectApprovedSource } from "../scripts/huangque/lib/collector.mjs";

function byteDanceSource({ collection = null, approvedAt = "2026-08-19T00:00:00.000Z" } = {}) {
  return {
    id: "bytedance-rotation",
    sourceKey: "career:bytedance:jobs.bytedance.com",
    revision: 1,
    lifecycle: "approved",
    collectionEnabled: true,
    collection,
    approvedAt,
    review: { reviewedAt: approvedAt },
    candidate: {
      provider: "ByteDance",
      tenant: "bytedance",
      publisher: "字节跳动",
      sourceType: "official_ats",
      sourceRootUrl: "https://jobs.bytedance.com/experienced/position",
      publicApiUrl: "https://jobs.bytedance.com/api/v1/search/job/posts",
      scopeSignals: ["全国"],
    },
    probe: { collectionEndpoint: "https://jobs.bytedance.com/api/v1/search/job/posts" },
  };
}

function fixtureRegistry(source) {
  const stores = [];
  return {
    stores,
    async snapshot() { return { sources: [source] }; },
    async storeJobs(sourceId, jobs, options) {
      stores.push({ sourceId, jobs, options });
      return { received: jobs.length, new: jobs.length, updated: 0, unchanged: 0, missing: 0 };
    },
  };
}

function chinaRows(offset, count, { padding = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(offset + index),
    title: `字节工程师 ${offset + index}`,
    city_info: { name: index % 2 ? "北京" : "湖北省武汉市" },
    ...(padding && index === 0 ? { description: "x".repeat(padding) } : {}),
  }));
}

function byteDanceNetwork(searchHandler, offsets = []) {
  return async (url, options = {}) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    }
    if (url.endsWith("/api/v1/csrf/token")) {
      return new Response(JSON.stringify({ code: 0, data: { token: "rotation-token" } }), {
        headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=rotation-cookie; Secure" },
      });
    }
    const body = JSON.parse(options.body);
    offsets.push(body.offset);
    return searchHandler(body.offset, body);
  };
}

async function collectFixture({ source = byteDanceSource(), startOffset = undefined, searchHandler }) {
  const registry = fixtureRegistry(source);
  const offsets = [];
  const result = await collectApprovedSource(registry, source.id, {
    commit: true,
    now: new Date("2026-08-20T00:00:00.000Z"),
    startOffset,
    fetchOptions: { fetchImpl: byteDanceNetwork(searchHandler, offsets), skipDns: true },
  });
  return { result, registry, offsets };
}

test("an offset-zero full traversal is authoritative and closes its cursor cycle", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 0,
    searchHandler(offset) {
      const rows = chinaRows(offset, offset === 0 ? 100 : 2);
      return new Response(JSON.stringify({ code: 0, data: { count: 102, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(offsets, [0, 100]);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.pagination.stopReason, "advertised_total_reached");
  assert.equal(result.pagination.advertisedTotal, 102);
  assert.equal(result.pagination.startOffset, 0);
  assert.equal(result.pagination.observedEndOffset, 102);
  assert.equal(result.pagination.nextOffset, 0);
  assert.equal(result.pagination.overlapRows, 100);
  assert.equal(result.pagination.cycleEndReached, true);
  assert.equal(result.pagination.headRefreshRows, 0);
  assert.equal(result.pagination.tailRowsObserved, 102);
  assert.match(result.pagination.cursorFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.pagination.cursorGeneration, 0);
  assert.deepEqual(registry.stores[0].options.collectionCheckpoint, {
    schemaVersion: "huangque.collection-resume.v1",
    fingerprint: result.pagination.cursorFingerprint,
    generation: 0,
    startOffset: 0,
    nextOffset: 0,
    cycleEndReached: true,
    headRefreshRows: 0,
    tailRowsObserved: 102,
  });
  assert.equal(registry.stores[0].options.allowMissingAdvance, true);
  assert.equal(result.storage.missingAdvanceSuppressed, false);
});

test("a resumed tail segment reaches cycle end but can never advance missing jobs", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 4_900,
    searchHandler(offset) {
      const rows = chinaRows(offset, offset === 5_000 ? 2 : 100);
      return new Response(JSON.stringify({ code: 0, data: { count: 5_002, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(offsets, [0, 4_900, 5_000]);
  assert.equal(result.pagination.startOffset, 4_900);
  assert.equal(result.pagination.observedEndOffset, 5_002);
  assert.equal(result.pagination.nextOffset, 0);
  assert.equal(result.pagination.cycleEndReached, true);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.headRefreshRows, 100);
  assert.equal(result.pagination.tailRowsObserved, 102);
  assert.equal(registry.stores[0].options.allowMissingAdvance, false);
  assert.equal(registry.stores[0].options.markMissingNeedsReview, false);
  assert.equal(result.storage.missingAdvanceSuppressed, true);
});

test("page-limit checkpoints advance with one upstream page of overlap", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 0,
    searchHandler(offset) {
      return new Response(JSON.stringify({ code: 0, data: { count: 10_000, job_post_list: chinaRows(offset, 100) } }), { headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(offsets.length, 50);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 4_900);
  assert.equal(result.pagination.stopReason, "page_limit_reached");
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.cycleEndReached, false);
  assert.equal(result.pagination.observedEndOffset, 5_000);
  assert.equal(result.pagination.nextOffset, 4_900);
  assert.equal(result.pagination.overlapRows, 100);
  assert.equal(registry.stores[0].options.allowMissingAdvance, false);
});

test("a resumed run spends one of the global fifty-page budget on its head refresh", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 5_000,
    searchHandler(offset) {
      return new Response(JSON.stringify({ code: 0, data: { count: 20_000, job_post_list: chinaRows(offset, 100) } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(offsets.length, 50);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 5_000);
  assert.equal(offsets.at(-1), 9_800);
  assert.equal(result.pagination.stopReason, "page_limit_reached");
  assert.equal(result.pagination.headRefreshRows, 100);
  assert.equal(result.pagination.tailRowsObserved, 4_900);
  assert.equal(result.pagination.observedEndOffset, 9_900);
  assert.equal(result.pagination.nextOffset, 9_800);
  assert.equal(result.parserStats.observedRows, 5_000);
  assert.equal(registry.stores[0].jobs.length, 5_000);
});

test("head refresh and overlapping tail rows are unified before storage", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 50,
    searchHandler(offset) {
      return new Response(JSON.stringify({ code: 0, data: { count: 150, job_post_list: chinaRows(offset, 100) } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(result.pagination.headRefreshRows, 100);
  assert.equal(result.pagination.tailRowsObserved, 100);
  assert.equal(result.parserStats.observedRows, 200);
  assert.equal(result.storage.received, 150);
  assert.equal(result.dedupe.stats.exactMerged, 50);
  assert.equal(registry.stores[0].jobs.length, 150);
});

test("byte-budget checkpoints retry the unaccepted page and retain a one-page overlap", async () => {
  const { result, registry, offsets } = await collectFixture({
    startOffset: 3_000,
    searchHandler(offset) {
      const rows = chinaRows(offset, 100, { padding: 5_400_000 });
      return new Response(JSON.stringify({ code: 0, data: { count: 10_000, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(offsets, [0, 3_000, 3_100, 3_200, 3_300]);
  assert.equal(result.pagination.stopReason, "byte_budget_reached");
  assert.equal(result.pagination.pages, 4);
  assert.equal(result.pagination.headRefreshRows, 100);
  assert.equal(result.pagination.tailRowsObserved, 300);
  assert.equal(result.pagination.observedEndOffset, 3_300);
  assert.equal(result.pagination.nextOffset, 3_200);
  assert.equal(result.pagination.cycleEndReached, false);
  assert.equal(result.pagination.complete, false);
  assert.equal(registry.stores[0].jobs.length, 400);
  assert.equal(registry.stores[0].options.allowMissingAdvance, false);
});

test("repeated-page and advertised-gap guards never skip beyond untrusted rows", async (t) => {
  await t.test("repeated page", async () => {
    const repeated = chinaRows(1_000, 100);
    const { result, registry, offsets } = await collectFixture({
      startOffset: 1_000,
      searchHandler() {
        return new Response(JSON.stringify({ code: 0, data: { count: 10_000, job_post_list: repeated } }), { headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(offsets, [0, 1_000]);
    assert.equal(result.pagination.stopReason, "offset_not_honored");
    assert.equal(result.pagination.headRefreshRows, 100);
    assert.equal(result.pagination.tailRowsObserved, 0);
    assert.equal(result.pagination.observedEndOffset, 1_000);
    assert.equal(result.pagination.nextOffset, 1_000);
    assert.equal(result.pagination.cycleEndReached, false);
    assert.equal(registry.stores[0].options.allowMissingAdvance, false);
  });

  await t.test("advertised total gap", async () => {
    const { result, registry, offsets } = await collectFixture({
      startOffset: 2_000,
      searchHandler(offset) {
        const rows = [0, 2_000].includes(offset) ? chinaRows(offset, 100) : [];
        return new Response(JSON.stringify({ code: 0, data: { count: 10_000, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(offsets, [0, 2_000, 2_100]);
    assert.equal(result.pagination.stopReason, "advertised_total_gap");
    assert.equal(result.pagination.observedEndOffset, 2_100);
    assert.equal(result.pagination.nextOffset, 2_000);
    assert.equal(result.pagination.cycleEndReached, false);
    assert.equal(result.pagination.complete, false);
    assert.equal(registry.stores[0].options.allowMissingAdvance, false);
  });
});

test("Feishu uses the same resumed-offset safety contract", async () => {
  const source = {
    ...byteDanceSource(),
    id: "feishu-rotation",
    sourceKey: "ats:feishu:nio.jobs.feishu.cn",
    candidate: {
      provider: "FeishuRecruitment",
      tenant: "nio",
      publisher: "NIO 蔚来",
      sourceType: "official_ats",
      sourceRootUrl: "https://nio.jobs.feishu.cn/index",
      publicApiUrl: "https://nio.jobs.feishu.cn/api/v1/search/job/posts",
      scopeSignals: ["全国"],
    },
    probe: { collectionEndpoint: "https://nio.jobs.feishu.cn/api/v1/search/job/posts" },
  };
  const registry = fixtureRegistry(source);
  const offsets = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/v1/csrf/token")) {
      assert.equal(options.body, undefined);
      return new Response(JSON.stringify({ code: 0, data: { token: "feishu-rotation-token" } }), {
        headers: { "content-type": "application/json", "set-cookie": "atsx-csrf-token=feishu-rotation-cookie; Secure" },
      });
    }
    const body = JSON.parse(options.body);
    offsets.push(body.offset);
    assert.equal(body.portal_type, 6);
    return new Response(JSON.stringify({ code: 0, data: { count: 101, job_post_list: chinaRows(body.offset, 1) } }), { headers: { "content-type": "application/json" } });
  };

  const result = await collectApprovedSource(registry, source.id, {
    commit: true,
    now: new Date("2026-08-20T00:00:00.000Z"),
    startOffset: 100,
    fetchOptions: { fetchImpl, skipDns: true },
  });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(result.pagination.startOffset, 100);
  assert.equal(result.pagination.observedEndOffset, 101);
  assert.equal(result.pagination.nextOffset, 0);
  assert.equal(result.pagination.cycleEndReached, true);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.headRefreshRows, 1);
  assert.equal(result.pagination.tailRowsObserved, 1);
  assert.equal(registry.stores[0].options.allowMissingAdvance, false);
});

test("cursor fingerprints bind resume state to the approved trust epoch", async () => {
  const source = byteDanceSource();
  const oneRow = (offset) => new Response(JSON.stringify({ code: 0, data: { count: 1, job_post_list: chinaRows(offset, 1) } }), { headers: { "content-type": "application/json" } });
  const seed = await collectFixture({ source, startOffset: 0, searchHandler: oneRow });
  const fingerprint = seed.result.pagination.cursorFingerprint;

  source.collection = { resume: {
    schemaVersion: "huangque.collection-resume.v1",
    fingerprint,
    generation: 7,
    nextOffset: 100,
  } };
  const resumed = await collectFixture({
    source,
    searchHandler(offset) {
      const rows = chinaRows(offset, offset === 0 ? 100 : 1);
      return new Response(JSON.stringify({ code: 0, data: { count: 101, job_post_list: rows } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(resumed.offsets, [0, 100]);
  assert.equal(resumed.result.pagination.startOffset, 100);
  assert.equal(resumed.result.pagination.cursorGeneration, 7);
  assert.equal(resumed.registry.stores[0].options.collectionCheckpoint.generation, 7);

  source.collection.resume = { ...source.collection.resume, fingerprint: "sha256:wrong", generation: 99, nextOffset: 9_999 };
  const reset = await collectFixture({ source, searchHandler: oneRow });
  assert.deepEqual(reset.offsets, [0]);
  assert.equal(reset.result.pagination.startOffset, 0);
  assert.equal(reset.result.pagination.cursorGeneration, 0);

  source.collection.resume = { ...source.collection.resume, fingerprint, generation: 7, nextOffset: 50_000_001 };
  const boundedReset = await collectFixture({ source, searchHandler: oneRow });
  assert.deepEqual(boundedReset.offsets, [0]);
  assert.equal(boundedReset.result.pagination.startOffset, 0);
  assert.equal(boundedReset.result.pagination.cursorGeneration, 0);

  const reapproved = byteDanceSource({ approvedAt: "2026-08-20T00:00:00.000Z" });
  const changedEpoch = await collectFixture({ source: reapproved, startOffset: 0, searchHandler: oneRow });
  assert.notEqual(changedEpoch.result.pagination.cursorFingerprint, fingerprint);
});

test("invalid or unsupported start offsets fail before network collection", async (t) => {
  const source = byteDanceSource();
  const registry = fixtureRegistry(source);
  await t.test("negative", async () => {
    await assert.rejects(
      () => collectApprovedSource(registry, source.id, { startOffset: -1 }),
      (error) => error.code === "INVALID_START_OFFSET",
    );
  });
  await t.test("fractional", async () => {
    await assert.rejects(
      () => collectApprovedSource(registry, source.id, { startOffset: 1.5 }),
      (error) => error.code === "INVALID_START_OFFSET",
    );
  });
  await t.test("offset above hard maximum", async () => {
    await assert.rejects(
      () => collectApprovedSource(registry, source.id, { startOffset: 50_000_001 }),
      (error) => error.code === "INVALID_START_OFFSET",
    );
  });
  await t.test("generation above hard maximum", async () => {
    await assert.rejects(
      () => collectApprovedSource(registry, source.id, { cursorGeneration: 1_000_000_001 }),
      (error) => error.code === "INVALID_CURSOR_GENERATION",
    );
  });

  const lever = {
    ...source,
    id: "lever-no-offset",
    candidate: {
      provider: "Lever",
      tenant: "example",
      sourceRootUrl: "https://jobs.lever.co/example",
      publicApiUrl: "https://api.lever.co/v0/postings/example?mode=json",
    },
  };
  await t.test("unsupported provider", async () => {
    await assert.rejects(
      () => collectApprovedSource(fixtureRegistry(lever), lever.id, { startOffset: 100 }),
      (error) => error.code === "START_OFFSET_UNSUPPORTED",
    );
  });
});
