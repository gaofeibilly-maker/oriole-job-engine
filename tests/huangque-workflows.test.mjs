import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const workflowNames = [
  "ci.yml",
  "daily-oriole.yml",
  "employer-universe-refresh.yml",
  "live-source-audit.yml",
  "source-spider.yml",
  "state-recovery-audit.yml",
];
const writerWorkflowNames = [
  "daily-oriole.yml",
  "employer-universe-refresh.yml",
  "source-spider.yml",
  "state-recovery-audit.yml",
];

async function workflow(name) {
  return readFile(resolve(projectRoot, ".github", "workflows", name), "utf8");
}

function assertInOrder(body, fragments, label) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = body.indexOf(fragment);
    assert.ok(index >= 0, `${label} is missing ${JSON.stringify(fragment)}`);
    assert.ok(index > previous, `${label} must place ${JSON.stringify(fragment)} after the previous contract step`);
    previous = index;
  }
}

function gitAddLines(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("git add "));
}

test("workflow action majors are explicit and consistent", async () => {
  const expectedVersions = new Map([
    ["actions/checkout", "v6"],
    ["actions/setup-node", "v6"],
    ["actions/upload-artifact", "v7"],
  ]);
  const observed = new Map([...expectedVersions.keys()].map((name) => [name, 0]));

  for (const name of workflowNames) {
    const body = await workflow(name);
    const references = [...body.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*([^ \t#\r\n]+)[ \t]*$/gm)].map((match) => match[1]);
    assert.ok(references.length > 0, `${name} must pin every action reference`);
    for (const reference of references) {
      const separator = reference.lastIndexOf("@");
      assert.ok(separator > 0, `${name} has an unpinned action: ${reference}`);
      const action = reference.slice(0, separator);
      const version = reference.slice(separator + 1);
      assert.equal(version, expectedVersions.get(action), `${name} uses an unexpected version for ${action}`);
      observed.set(action, (observed.get(action) ?? 0) + 1);
    }
  }

  for (const [action, count] of observed) {
    assert.ok(count > 0, `${action} should be covered by at least one workflow`);
  }
});

test("every durable-state writer shares the non-cancelling max queue", async () => {
  for (const name of writerWorkflowNames) {
    const body = await workflow(name);
    assert.match(
      body,
      /^concurrency:\s*\n(?:\s*#[^\n]*\n)*\s*group: oriole-state-writer\s*\n\s*queue: max\s*\n\s*cancel-in-progress: false$/m,
      `${name} must participate in the one durable-state writer queue`,
    );
    assert.match(body, /^permissions:\s*\n\s*contents: write$/m, `${name} needs explicit write permission`);
  }
});

test("Registry writers verify, restore, repack, and remove plaintext before persistence", async () => {
  for (const name of ["daily-oriole.yml", "source-spider.yml"]) {
    const body = await workflow(name);
    assertInOrder(body, [
      "state-bundle.mjs unpack --state-dir state/state-data",
      "HUANGQUE_REGISTRY_PATH: ${{ github.workspace }}/state/state-data/registry.json",
      "test -f state-data/registry.json",
      "state-bundle.mjs pack --state-dir state-data",
      "rm -f -- state-data/registry.json",
      "test ! -e state-data/registry.json",
      "git push origin HEAD:oriole-state",
    ], name);
    assert.match(body, /state\/state-data\/registry\.json\.gz/);
    assert.match(body, /state\/state-data\/registry\.bundle-manifest\.json/);

    const uploadBlock = body.slice(body.lastIndexOf("- name: Upload"));
    assert.doesNotMatch(uploadBlock, /(?:^|\/)registry\.json(?:\s|$)/m, `${name} must never upload plaintext Registry state`);
    assert.doesNotMatch(body, /actions\/cache\/(?:restore|save)@/, `${name} must not use a cache as durable state`);
  }
});

test("state persistence uses only the reviewed allowlists", async () => {
  const expectedStagePaths = new Map([
    ["daily-oriole.yml", [
      "state-data/registry.json",
      "state-data/registry.json.gz",
      "state-data/registry.bundle-manifest.json",
      "state-data/latest-job-update.json",
      "state-data/latest-audit.json",
      "state-data/hosted-snapshot.json",
      "state-data/job-updates",
    ]],
    ["source-spider.yml", [
      "state-data/registry.json",
      "state-data/registry.json.gz",
      "state-data/registry.bundle-manifest.json",
      "state-data/source-spider-state.json",
      "state-data/latest-source-spider.json",
      "state-data/source-spider-runs",
    ]],
  ]);

  for (const [name, expected] of expectedStagePaths) {
    const body = await workflow(name);
    const actual = [...body.matchAll(/^[ \t]*stage_path[ \t]+([^ \t#\r\n]+)[ \t]*$/gm)].map((match) => match[1]);
    assert.deepEqual(actual, expected, `${name} staging allowlist changed without contract review`);
    assert.deepEqual(gitAddLines(body), ['git add -A -- "$1"']);
  }

  const employer = await workflow("employer-universe-refresh.yml");
  assert.match(employer, /test ! -e state-data\/registry\.json/);
  assert.deepEqual(gitAddLines(employer), ["git add -A -- state-data/employer-universe.json"]);

  const recovery = await workflow("state-recovery-audit.yml");
  assert.deepEqual(gitAddLines(recovery), ["git add -- state-data/latest-state-recovery.json"]);

  for (const name of writerWorkflowNames) {
    const body = await workflow(name);
    assert.doesNotMatch(body, /^\s*git add (?:-A|--all)(?:\s+--)?\s+(?:\.|state-data\/?|\*)\s*$/gm, `${name} contains broad staging`);
  }
});

test("state writers reject transient files before staging", async () => {
  for (const name of writerWorkflowNames) {
    const body = await workflow(name);
    const firstGitAdd = body.indexOf("git add ");
    const forbiddenTokens = ["-type l", "-name '*.lock'", "-name '*.tmp'", "-name '*.backup'"];
    const forbiddenIndexes = forbiddenTokens.map((token) => body.indexOf(token));
    assert.ok(forbiddenIndexes.every((index) => index >= 0), `${name} must reject symlinks, locks, temporary, and backup state`);
    assert.ok(forbiddenIndexes.every((index) => firstGitAdd > index), `${name} must reject transient state before staging`);
  }
});

test("recovery copies and verifies the complete tree before a leased one-root replacement", async () => {
  const body = await workflow("state-recovery-audit.yml");
  assertInOrder(body, [
    "EXPECTED_SHA=\"$(git rev-parse HEAD)\"",
    "REMOTE_SHA=\"$(git ls-remote --exit-code origin refs/heads/oriole-state | awk '{print $1}')\"",
    "test ! -e state/state-data/registry.json",
    "cp -a state/state-data/. \"${RUNNER_TEMP}/oriole-recovery/state-data/\"",
    "state-bundle.mjs unpack --state-dir \"${RUNNER_TEMP}/oriole-recovery/state-data\"",
    "npm run --silent status",
    "--source-state-dir \"${GITHUB_WORKSPACE}/state/state-data\"",
    "--restored-state-dir \"${RUNNER_TEMP}/oriole-recovery/state-data\"",
    "--state-commit-sha \"${ORIOLE_STATE_EXPECTED_SHA}\"",
    "git add -- state-data/latest-state-recovery.json",
    "git diff --cached --name-only",
    "git diff --name-only",
    "git ls-files --others --exclude-standard",
    "git write-tree",
    "git commit-tree",
    "git rev-list --parents -n 1",
    "git push --force-with-lease=refs/heads/oriole-state:${ORIOLE_STATE_EXPECTED_SHA}",
  ], "state-recovery-audit.yml");
  assert.ok(body.includes("find state/state-data \\( -type l -o -name 'registry.json'"));
  assert.match(body, /STAGED[^\n]*latest-state-recovery\.json/);
  assert.doesNotMatch(body, /git push\s+(?:--force|-f)(?:\s|$)(?!-with-lease)/);
  assert.doesNotMatch(body, /git add -A -- state-data/);
});
