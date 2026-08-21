import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const expectedVersion = "1.1.1";

test("package, lockfile, CLI and changelog identify the same release", async () => {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
  const changelog = await readFile(resolve(projectRoot, "CHANGELOG.md"), "utf8");
  const cli = spawnSync(process.execPath, [resolve(projectRoot, "scripts/huangque/cli.mjs"), "help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageLock.version, expectedVersion);
  assert.equal(packageLock.packages[""].version, expectedVersion);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`黄雀 ${expectedVersion.replaceAll(".", "\\.")}：`));
  assert.match(changelog, new RegExp(`^## ${expectedVersion.replaceAll(".", "\\.")} — `, "m"));
});
