# Verification guide

This guide is intentionally conservative. It keeps three audit claims non-interchangeable:

1. **Implementation — `implementationComplete`**: the runtime code, workflow wiring, schemas, and safety gates checked by the machine audit exist. The separate deterministic suite verifies `init-state` and other release contracts that this summary boolean does not enumerate.
2. **Operational now — `operationalNow`**: current durable data plus recent real Provider, GitHub scheduler, spider, and full-state recovery evidence all pass the audit.
3. **Cross-day maturity — `maturityObserved`**: successful GitHub job-update and online-evidenced source-spider receipts each cover at least two distinct Beijing natural dates.

Local deterministic verification and `stateIntegrityPassed` are additional checks, not a fourth operational claim and not substitutes for online evidence. A fixture is not a live Provider result. A configured cron or initialized branch is not a completed run. One successful manual or scheduled invocation proves only that invocation. Cross-day maturity measures repetition and does not imply that every shorter `operationalNow` recency window still passes; `fullyOperational` requires all audit categories together.

## 1. Verify the code locally

Install Node.js `22.13+`, open a terminal in the repository, and run:

```bash
npm ci --ignore-scripts
npm run verify
```

Success means all tests pass, the Hubei region smoke check returns its second-level entries, and the final line includes `Secret scan passed.` If any command exits nonzero, stop and treat local verification as failed.

The deterministic suite covers, among other things:

- the 5,000+ employer-universe lower bound and its four official directory inputs;
- the fixed 19-employer versioned priority inventory, including the ByteDance root `https://jobs.bytedance.com/`;
- nine source channels;
- 34 province-level entries, 365 second-level entries, and 833 expanded queries, including 730 prefecture-rotation tasks;
- candidate/probe/approval boundaries;
- ByteDance/Feishu bounded cursor rotation and missing-job suppression;
- ETag/Last-Modified conditional requests and safe HTTP 304 handling;
- Registry locking, revision conflicts, graph evidence, and artifact hashing;
- clean four-file `oriole-state` initialization, gzip/manifest bounds, and full-tree recovery receipts;
- 14-day hosted job freshness and referentially closed projections;
- 18 bilingual MCP tools, official MCP client interoperability, protocol negotiation, argument validation, and bounded output;
- HTTPS, SSRF, DNS, redirect, robots, timeout, size, row, rate, and secret-host protections.

This result establishes “implemented and locally verified.” It says nothing about whether your GitHub schedules or external providers have run successfully.

## 2. Start from an isolated local state

The following Unix/macOS commands keep verification separate from your normal data:

```bash
export HUANGQUE_REGISTRY_PATH="$(pwd)/.huangque/verify-state.json"
export HUANGQUE_ARTIFACT_ROOT="$(pwd)/.huangque/verify-artifacts"

npm run init
npm run status
npm run coverage
npm run regions -- --province-code 420000
```

Check these facts in the JSON output:

- `init` imports nine reviewed sources and no bundled job snapshot;
- the scope is nationwide;
- the employer universe reports at least 5,000 targets;
- region data contains 34 province-level and 365 second-level entries;
- coverage reports nine planned channels and the versioned 19-employer priority inventory;
- a clean Registry has zero real jobs until a network collection is explicitly committed.

Do not interpret the 5,000+ universe as 5,000+ approved sources. It is the bounded denominator for source discovery.

## 3. Verify that discovery cannot approve a source

Import the checked-in official catalog:

```bash
node scripts/huangque/cli.mjs discover --providers official_catalog --force
node scripts/huangque/cli.mjs sources
node scripts/huangque/cli.mjs graph
```

New results must remain candidates. To approve one, a person must first probe it, read the evidence, and submit an explicit review with the current Registry revision:

```bash
node scripts/huangque/cli.mjs probe --source <source-id>

node scripts/huangque/cli.mjs review \
  --source <source-id> \
  --decision approve \
  --reviewer <operator-name> \
  --reason "Official public recruitment source verified" \
  --revision <current-revision> \
  --confirm
```

Only a `verified + approved + collectionEnabled` source may then be collected. The source spider follows the same boundary and has no auto-approval operation.

## 4. Verify workplace and job freshness behavior

Check the two-level labels:

```bash
npm run regions -- --province-code 110000
npm run regions -- --province-code 420000
```

Beijing should display as `北京`; Wuhan should display as `湖北省-武汉市`. After collecting an approved source, query by workplace rather than employer headquarters:

```bash
node scripts/huangque/cli.mjs jobs --province-code 420000
node scripts/huangque/cli.mjs jobs --province-code 420000 --city-code 420100
```

Inspect `locationRaw`, `workLocations`, province/city codes, confidence, and source evidence. Multi-city roles should retain every defensible workplace; foreign-only roles should not be classified as China jobs.

After `npm run daily`, inspect `.huangque/hosted-snapshot.json`. Under `metadata.hostedProjection.freshnessPolicy`, `maximumAgeDays` must be `14`. A job without qualifying source-scoped evidence inside that window is excluded from the hosted current-job projection, but its historical evidence remains in the complete Registry. A partial cursor run must not renew an unseen job.

## 5. Verify MCP for a compatible client

Run both the server lifecycle suite and the official-client interoperability suite:

```bash
node --test \
  tests/huangque-mcp.test.mjs \
  tests/huangque-mcp-official-client.test.mjs
```

For a manual stdio check, start:

```bash
npm run mcp
```

Send one JSON object per line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-check","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Verify that `serverInfo.version` is `2.0.0` and exactly 18 tools are returned, including `huangque.run_source_spider`, `huangque.run_job_update`, and `huangque.source_coverage`. Source approval through MCP must remain rejected unless the operator intentionally enabled `HUANGQUE_ALLOW_MCP_REVIEW=1`.

This proves compatibility with clients that support MCP stdio. It does not create a public remote endpoint, and it does not make every LLM automatically able to connect.

## 6. Optional real-provider checks

### Without Baidu

```bash
unset HUANGQUE_BAIDU_API_KEY
npm run status
```

`providerConfiguration.baidu` should be `not_configured`. Approved-source collection and official-catalog discovery remain available. Baidu-only keyword work must stay visibly blocked; Common Crawl may run only controlled `site:` tasks.

### Common Crawl

```bash
node scripts/huangque/cli.mjs discover \
  --providers common_crawl \
  --buckets national-official,public-ats \
  --max-queries 6 \
  --force
```

Call this a live Common Crawl success only if the run status is successful and its metadata contains a real index ID. A DNS, network, schema, or rate-limit error remains a failure.

### Baidu

Set `HUANGQUE_BAIDU_API_KEY` without printing it, then run one bounded request:

```bash
node scripts/huangque/cli.mjs discover \
  --providers baidu \
  --buckets national-official \
  --max-queries 1 \
  --force
```

Call this a live Baidu success only when the Registry records an admitted successful request. Never print or place the key in a receipt.

### ByteDance

On a machine with ordinary public Internet access:

```bash
npm --silent run live-source-check > live-source-summary.json
```

The preview must fail closed if robots cannot be verified, the public endpoint changes, no China jobs are returned, or an application URL leaves the official ByteDance recruitment origin. Preview does not commit jobs or advance a cursor. The priority employer root is `https://jobs.bytedance.com/`; the reviewed experienced-hire listing is `https://jobs.bytedance.com/experienced/position`.

## 7. Verify local job and spider separation

Run the job updater twice on the same Beijing date:

```bash
npm run daily
npm run daily
```

The second successful invocation should report `skipped: true`. The job receipt is `.huangque/latest-job-update.json`; dated receipts are under `.huangque/job-updates/`. The job updater must not perform source discovery.

Run the source spider separately:

```bash
npm run source-spider
```

It should write a source-spider receipt and persistent queue state, and any new source must remain candidate/probed. Local execution proves the scripts are wired locally; it is not GitHub Actions evidence.

## 8. Verify the GitHub reference deployment

### 8.1 Create the state branch once

If `oriole-state` does not yet exist, create it before dispatching any state-writing workflow. Run this from a clone whose `origin` is the intended repository:

```bash
ORIOLE_ORIGIN_URL="$(git remote get-url origin)"
ORIOLE_BOOTSTRAP_ROOT="$(mktemp -d)"
mkdir "$ORIOLE_BOOTSTRAP_ROOT/repository"

npm run init-state -- \
  --output "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"

ls -1 "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"
test ! -e "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data/registry.json"

git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" init -b oriole-state
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.name "Oriole State Bootstrap"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.email "actions@users.noreply.github.com"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" remote add origin "$ORIOLE_ORIGIN_URL"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" add -- state-data
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" diff --cached --name-only
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" commit -m "state: initialize oriole-state"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" push origin HEAD:refs/heads/oriole-state
```

Before the commit, the staged list must contain only the four paths below:

```text
state-data/employer-universe.json
state-data/registry.bundle-manifest.json
state-data/registry.json.gz
state-data/source-spider-state.json
```

The JSON summary from `init-state` must report `status: "completed"`, nine seeded/approved sources, zero jobs, zero runs, zero receipts, and `plaintextPersisted: false`. The non-forced push must fail if the remote branch already exists; do not replace an existing state branch with a new empty bootstrap.

Inspect `registry.bundle-manifest.json`: `bundle.maxBytes` must be `94371840` (90 MiB), below [GitHub's official 100 MiB per-file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits). This guard proves only that the reference bundle fits its configured bound; it is not an unbounded storage claim.

This is only deployment initialization. It does not establish an online Provider result, a job/spider receipt, a recovery exercise, `operationalNow`, or `maturityObserved`.

### 8.2 Check the configured workflows

First confirm the configured schedules in the workflow files:

| Workflow | Beijing target | UTC cron |
| --- | --- | --- |
| Job update | daily `00:17` | `17 16 * * *` |
| Employer universe | Sunday `01:15` | `15 17 * * 6` |
| Source spider | daily `02:30` | `30 18 * * *` |
| Deep scan | Sunday `03:30` | `30 19 * * 6` |
| State recovery | Sunday `04:47` | `47 20 * * 6` |

Then use the repository's **Actions** page:

1. Manually run the employer-universe refresh and inspect that the persisted file remains a fully validated 5,000+ target snapshot.
2. Manually run the job-update workflow and wait for a green completion.
3. Manually run the ordinary source-spider workflow and inspect the receipt; a green wrapper alone is insufficient unless the business status is successful and `onlineEvidence.present` is `true`.
4. Manually run the state-recovery audit and wait for a green completion.
5. Open the `oriole-state` branch and confirm the complete tree: `state-data/registry.json.gz`, `registry.bundle-manifest.json`, `employer-universe.json`, `source-spider-state.json`, job/spider receipts, and `latest-state-recovery.json`. Confirm plaintext `registry.json`, symlinks, and lock/temp/backup files are absent.
6. Download each run's artifact and confirm its configured retention is 30 days. Raw collection evidence belongs in artifacts, not the public code branch.

For the job receipt, require `trigger: "github_actions"` and a successful status (`completed`, `completed_with_findings`, or `no_work`) and correlate it with the state commit/Actions run. For the spider receipt, additionally require `onlineEvidence.present: true`; an imported-only queue pass is a failure, not online success. The v2 recovery receipt must carry GitHub/state commit identities, matching full-tree inventory hashes, a verified Registry bundle, valid employer/spider state, matching Agent status, and no persisted plaintext/transient files. If these workflows have not actually produced that evidence, report “implemented/configured, operational verification pending.”

Those receipts are still only part of `operationalNow`. The machine audit also requires a nonempty real job set with traceability and structured workplace data, required graph edge types, actual spider queue attempts, a recent official-catalog observation (10 days), recent Baidu and Common Crawl observations (35 days), recent job/spider receipts (36 hours), and a recent recovery receipt (8 days). Baidu remains optional for basic approved-source collection, but the strongest all-channel `operationalNow` result intentionally remains false without recent admitted Baidu evidence.

## 9. Verify cross-day maturity

Wait for another natural date and repeat (or let the schedules run). Then inspect the dated directories on `oriole-state`:

- GitHub job-update receipts with a successful status must cover at least two different `Asia/Shanghai` dates;
- GitHub source-spider receipts with a successful status and `onlineEvidence.present: true` must cover at least two different `Asia/Shanghai` dates.

One date is insufficient even if several retries succeeded that day. Until both conditions are met, report “online run observed; cross-day maturity still pending.”

## 10. Read the machine audit correctly

```bash
npm run audit
npm run status
```

Read the independent results without collapsing the three claim levels:

- `implementationComplete`: required implementation/configuration is present;
- `stateIntegrityPassed`: current Registry invariants hold; this supports the claims but is not online evidence;
- `operationalNow`: all current real-data, Provider-recency, scheduler, spider, and recovery checks pass;
- `maturityObserved`: GitHub job success and online-evidenced spider success each cover two Beijing dates; this is repetition evidence, not current recency.

`fullyOperational` is true only when every category passes. A fresh clone should not pass online-operation or maturity checks, and that is honest behavior.

## 11. Boundaries and release hygiene

Before publishing:

```bash
npm run secret-scan
git status --short
```

Confirm that credentials, `.env`, `.huangque/`, raw responses, and live snapshots are absent from the public code branch. Oriole intentionally does not implement private WeChat-group collection, image ingestion/OCR, email inboxes, login/CAPTCHA bypass, automatic job applications, or employment decisions.
