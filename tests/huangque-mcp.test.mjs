import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const serverPath = join(projectRoot, "scripts/huangque/mcp-server.mjs");

async function withServer(run, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "huangque-mcp-"));
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv, HUANGQUE_REGISTRY_PATH: join(directory, "state.json"), HUANGQUE_ARTIFACT_ROOT: join(directory, "artifacts") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const queue = [];
  const waiters = [];
  lines.on("line", (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  const next = (timeoutMs = 3000) => new Promise((resolveLine, reject) => {
    if (queue.length) return resolveLine(queue.shift());
    const timer = setTimeout(() => reject(new Error("MCP response timeout")), timeoutMs);
    waiters.push((line) => { clearTimeout(timer); resolveLine(line); });
  });
  const send = (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  try {
    await run({ child, send, next });
  } finally {
    child.stdin.end();
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

test("legacy MCP 2025 lifecycle, tools, ping and notifications are NDJSON-clean", async () => {
  await withServer(async ({ send, next }) => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const initialized = JSON.parse(await next());
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    send({ jsonrpc: "2.0", id: "pre-initialized-ping", method: "ping" });
    assert.deepEqual(JSON.parse(await next()), { jsonrpc: "2.0", id: "pre-initialized-ping", result: {} });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = JSON.parse(await next());
    assert.equal(listed.id, 2);
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "huangque.run_pipeline",
      "huangque.get_run",
      "huangque.status",
      "huangque.discover_sources",
      "huangque.submit_source",
      "huangque.probe_source",
      "huangque.list_sources",
      "huangque.list_jobs",
      "huangque.list_regions",
      "huangque.get_source_graph",
      "huangque.review_source",
      "huangque.collect_jobs",
      "huangque.run_due",
      "huangque.audit",
      "huangque.export_hosted_projection",
    ]);
    assert.equal(listed.result.tools.find((tool) => tool.name === "huangque.probe_source").annotations.idempotentHint, false);
    assert.equal(listed.result.tools.find((tool) => tool.name === "huangque.collect_jobs").annotations.idempotentHint, false);
    assert.equal(listed.result.resultType, undefined);
    send({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(JSON.parse(await next()), { jsonrpc: "2.0", id: 3, result: {} });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "huangque.list_sources", arguments: {} } });
    const called = JSON.parse(await next());
    assert.equal(called.id, 4);
    assert.equal(called.result.isError, false);
    assert.equal(called.result.structuredContent.total, 0);
  });
});

test("common earlier MCP revisions negotiate on the same legacy stdio lifecycle", async () => {
  for (const protocolVersion of ["2025-06-18", "2025-03-26"]) {
    await withServer(async ({ send, next }) => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "compat-test", version: "1" } } });
      const initialized = JSON.parse(await next());
      assert.equal(initialized.result.protocolVersion, protocolVersion);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.equal(JSON.parse(await next()).result.tools.length, 15);
    });
  }
});

test("modern MCP 2026 supports server/discover and per-request metadata", async () => {
  await withServer(async ({ send, next }) => {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    send({ jsonrpc: "2.0", id: "discover", method: "server/discover", params: { _meta: meta } });
    const discovered = JSON.parse(await next());
    assert.equal(discovered.id, "discover");
    assert.equal(discovered.result.resultType, "complete");
    assert.ok(discovered.result.supportedVersions.includes("2026-07-28"));
    send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: { _meta: meta } });
    const listed = JSON.parse(await next());
    assert.equal(listed.result.resultType, "complete");
    assert.equal(listed.result.tools.length, 15);
    assert.equal(listed.result.tools.find((tool) => tool.name === "huangque.probe_source").inputSchema.anyOf.length, 2);
    send({ jsonrpc: "2.0", id: "call", method: "tools/call", params: { _meta: meta, name: "huangque.list_sources", arguments: {} } });
    const called = JSON.parse(await next());
    assert.equal(called.result.resultType, "complete");
    assert.deepEqual(called.result.structuredContent.sources, []);
  });
});

test("MCP applies a process-level invocation rate limit as a tool error", async () => {
  await withServer(async ({ send, next }) => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "rate-test", version: "1" } } });
    await next();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "huangque.list_sources", arguments: {} } });
    assert.equal(JSON.parse(await next()).result.isError, false);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "huangque.list_sources", arguments: {} } });
    const limited = JSON.parse(await next());
    assert.equal(limited.result.isError, true);
    assert.equal(limited.result.structuredContent.error.code, "RATE_LIMITED");
  }, { HUANGQUE_MCP_CALLS_PER_MINUTE: "1" });
});

test("MCP rejects premature lifecycle messages, malformed metadata and schema-invalid tool arguments", async () => {
  await withServer(async ({ send, next }) => {
    send({ jsonrpc: "2.0", id: "bad-init", method: "initialize", params: { protocolVersion: "2025-11-25" } });
    assert.equal(JSON.parse(await next()).error.code, -32602);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: "premature", method: "tools/list", params: {} });
    assert.equal(JSON.parse(await next()).error.code, -32002);

    send({ jsonrpc: "2.0", id: "bad-meta", method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": true,
    } } });
    assert.equal(JSON.parse(await next()).error.code, -32602);

    send({ jsonrpc: "2.0", id: "missing-version", method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/clientCapabilities": {},
    } } });
    assert.equal(JSON.parse(await next()).error.code, -32602);

    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    send({ jsonrpc: "2.0", id: "bad-args", method: "tools/call", params: {
      _meta: meta,
      name: "huangque.list_sources",
      arguments: { limit: "not-an-integer" },
    } });
    const invalidArguments = JSON.parse(await next());
    assert.equal(invalidArguments.result.isError, true);
    assert.equal(invalidArguments.result.structuredContent.error.code, "INVALID_ARGUMENTS");

    send({ jsonrpc: "2.0", id: "missing-probe-target", method: "tools/call", params: {
      _meta: meta,
      name: "huangque.probe_source",
      arguments: {},
    } });
    const missingProbeTarget = JSON.parse(await next());
    assert.equal(missingProbeTarget.result.isError, true);
    assert.equal(missingProbeTarget.result.structuredContent.error.code, "INVALID_ARGUMENTS");

    for (const [suffix, params] of [
      ["scalar-params", false],
      ["null-args", { _meta: meta, name: "huangque.list_sources", arguments: null }],
      ["array-args", { _meta: meta, name: "huangque.list_sources", arguments: [] }],
      ["false-args", { _meta: meta, name: "huangque.list_sources", arguments: false }],
    ]) {
      send({ jsonrpc: "2.0", id: suffix, method: "tools/call", params });
      assert.equal(JSON.parse(await next()).error.code, -32602, suffix);
    }
  });
});

test("MCP correlates errors, rejects unsupported versions and survives malformed framing", async () => {
  await withServer(async ({ send, next }) => {
    send("Content-Length: 2");
    assert.equal(JSON.parse(await next()).error.code, -32700);
    send({ jsonrpc: "2.0", id: 77, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } });
    const versionError = JSON.parse(await next());
    assert.equal(versionError.id, 77);
    assert.equal(versionError.error.code, -32022);
    send({ jsonrpc: "2.0", id: 78, method: "unknown", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
    const unknown = JSON.parse(await next());
    assert.equal(unknown.id, 78);
    assert.equal(unknown.error.code, -32601);
  });
});
