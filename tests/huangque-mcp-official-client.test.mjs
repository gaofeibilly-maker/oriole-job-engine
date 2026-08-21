import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const serverPath = join(projectRoot, "scripts/huangque/mcp-server.mjs");

test("the official MCP v2 client can negotiate, list tools, and call Oriole", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriole-official-mcp-client-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    env: {
      ...process.env,
      HUANGQUE_REGISTRY_PATH: join(directory, "registry.json"),
      HUANGQUE_ARTIFACT_ROOT: join(directory, "artifacts"),
      HUANGQUE_BAIDU_API_KEY: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "oriole-official-sdk-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 18);
    assert.ok(listed.tools.some((tool) => tool.name === "huangque.run_source_spider"));
    assert.ok(listed.tools.some((tool) => tool.name === "huangque.run_job_update"));

    const called = await client.callTool({
      name: "huangque.list_regions",
      arguments: { province_code: "420000" },
    });
    assert.equal(called.isError, false);
    assert.equal(called.structuredContent.schemaVersion, "huangque.regions.v1");
    assert.equal(called.structuredContent.regions[0].provinceCode, "420000");

    const noWork = await client.callTool({
      name: "huangque.run_job_update",
      arguments: { max_collections: 1, commit: false },
    });
    assert.equal(noWork.isError, false);
    assert.equal(noWork.structuredContent.status, "no_work");
    assert.equal(JSON.parse(noWork.content[0].text).completed, true);

    const blockedNetwork = await client.callTool({
      name: "huangque.probe_source",
      arguments: { url: "https://127.0.0.1/jobs" },
    });
    assert.equal(blockedNetwork.isError, true);
    assert.ok(["INVALID_SOURCE_URL", "UNSAFE_URL", "PRIVATE_ADDRESS"].includes(blockedNetwork.structuredContent.error.code));
  } finally {
    await client.close().catch(() => undefined);
  }
});
