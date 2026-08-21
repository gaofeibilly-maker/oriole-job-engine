# Verification guide

This guide separates three questions that are often confused:

1. **Does the code implement the promised behavior?** — deterministic tests.
2. **Is the local Agent wired correctly?** — CLI/MCP smoke checks.
3. **Did external providers really succeed in this Registry?** — runtime audit and run evidence.

Passing fixtures is never reported as a live Baidu or Common Crawl success.

## 1. Clean-room code verification

From a fresh clone with Node.js `22.13+`:

```bash
npm run verify
```

Expected result: every test passes, the nationwide smoke command returns the Hubei province entry with its prefecture-level children (including Wuhan), and the credential scan reports `Secret scan passed.` Public CI runs this exact complete command.

The suite covers:

- 34 province-level and 365 second-level region entries;
- municipality and `省-市` labels, including ambiguous same-name city review handling;
- multi-location jobs and foreign-only rejection;
- Lever, Greenhouse, Ashby, ByteDance/Feishu public search APIs, JSON-LD, XML, RSS/Atom, and generic payload behavior;
- Baidu request shape, query bounds, budgets, and partial failures;
- Common Crawl index selection, CDX query bounds, and evidence;
- per-task Provider capability, Baidu-only keyword blocking, and Common Crawl `site:` eligibility;
- candidate classification, source ownership, Registry graph evidence, and job identity;
- atomic Registry behavior, revision conflicts, retention, and preview versus commit;
- HTTPS, SSRF, DNS, redirect, robots, time, size, and artifact protections;
- MCP initialization across modern and three legacy revisions, tool schemas, invalid arguments, rate limits, and bounded outputs;
- unique province/province-only/city aggregates and referentially closed hosted projections.

## 2. Empty-state and official-catalog verification

Use a temporary Registry so the result is reproducible:

```bash
export HUANGQUE_REGISTRY_PATH="$(pwd)/.huangque/verify-state.json"
export HUANGQUE_ARTIFACT_ROOT="$(pwd)/.huangque/verify-artifacts"

npm run init
node scripts/huangque/cli.mjs discover --providers official_catalog --force
node scripts/huangque/cli.mjs sources
node scripts/huangque/cli.mjs graph
```

Verify that:

- init succeeds without a bundled job snapshot and imports 9 audited public sources;
- status shows 9 approved sources and 0 bundled jobs before collection;
- official-catalog discovery creates evidence-backed candidates;
- graph output contains `published_by`, `covers_region`, `has_entry_point`, and `discovered_via` relations;
- the graph summary reports 100% evidence coverage for its edges;
- catalog-discovered sources remain candidates/probed rather than silently approved; only the checked-in reviewed seed manifest is pre-approved.

## 3. Measurable source-coverage verification

Using the temporary Registry initialized in section 2, run:

```bash
npm run coverage
```

Verify that `nonExhaustive` is `true` and the summary reports 9 planned channels, 19 planned employer targets, 34 province-level regions, and 365 second-level regions. Immediately after clean initialization plus official-catalog discovery, only ByteDance should count as a covered employer target; the other 18 watchlist entries must remain listed in `missingTargetIds` even though they now exist as candidates. Channel and region gaps are expected until sources are separately probed, approved, enabled, and—where applicable—backed by active jobs with structured locations.

This command does not prove that a collection read every upstream page. It intentionally does not read `pagination.complete`. For ByteDance/Feishu or another bounded source, inspect the collection command result, the Registry run's `output.collectionEvidence`, or the daily report's `sourceRuns`; a run that reaches 50 pages, 5,000 rows, 24 MB, or an upstream gap must remain visibly incomplete.

## 4. Workplace verification

```bash
npm run regions -- --province-code 110000
npm run regions -- --province-code 420000
```

Verify that Beijing is presented as `北京`, while Wuhan is `湖北省-武汉市`. The automated fixtures also prove that a multi-location job retains every defensible location and that a Tokyo-only role is not classified as a China job.

After collecting an approved source:

```bash
node scripts/huangque/cli.mjs jobs --province-code 420000
node scripts/huangque/cli.mjs jobs --province-code 420000 --city-code 420100
```

Inspect `locationRaw`, `workLocations`, `regionProvinceCode`, `regionCityCode`, `regionLabel`, `locationConfidence`, and source evidence.

## 5. MCP verification

The automated MCP tests spawn the real stdio server. For a manual check, start:

```bash
npm run mcp
```

Send one JSON object per line. A legacy session starts with:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-check","version":"1"}}}
```

Then send the initialized notification and list tools:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Verify that `serverInfo.version` is `1.1.0`, that 16 tools are returned including `huangque.source_coverage`, and that `huangque.review_source` is rejected unless MCP review was explicitly enabled. Repeat initialization with `2025-06-18` and `2025-03-26`; each successful response must return the exact requested protocol revision. The automated release-consistency test also verifies that the outbound User-Agent identifies `HuangqueJobSourceAgent/1.1.0`.

For a collected multi-city job, compare `jobs` and `regions`: the province total must count the job once, while every explicit city gets its own count. Projection tests also assert that every `lists_job` target exists in the same bounded job array.

## 6. Real provider verification

First verify capability reporting without a Baidu credential:

```bash
unset HUANGQUE_BAIDU_API_KEY
node scripts/huangque/cli.mjs status
```

`providerConfiguration.baidu` must be `not_configured`. Ordinary keyword tasks must remain visible under `discoveryBacklog.blockedTasks` with reason `baidu_not_configured_or_not_selected`; they must not advance as completed. This does not block collection of the nine pre-approved sources or official-catalog discovery. Common Crawl is runnable only for query-plan tasks containing a controlled `site:` pattern.

### Official catalog

The command in section 2 is a real local import of the checked-in public catalog. In `status`, `providerEvidence.officialCatalog` should be `true` after the run.

### Common Crawl

```bash
node scripts/huangque/cli.mjs discover \
  --providers common_crawl \
  --buckets national-official,public-ats \
  --max-queries 6 \
  --force
```

In `status`, `providerEvidence.commonCrawl` becomes `true` only when the current Registry contains a successful run with a real Common Crawl index ID. Network/DNS/rate-limit failure remains visible and must not be relabeled as success.

Inspect the discovery result as well: `tasks` must contain only Common Crawl-eligible `site:` work, while ordinary keyword work appears in `blockedTasks` and `stats.blockedTaskIds`. A blocked task is not a Common Crawl failure and is not a completed task.

### Baidu

Set `HUANGQUE_BAIDU_API_KEY` in the environment without printing it, then run:

```bash
node scripts/huangque/cli.mjs discover \
  --providers baidu \
  --buckets national-official \
  --max-queries 1 \
  --force
```

In `status`, `providerEvidence.baidu` becomes `true` only after at least one admitted request completed successfully. Inspect the run metadata, never the key.

### ByteDance live collection evidence

Run the bounded, preview-only source check on a machine with ordinary public Internet access:

```bash
npm --silent run live-source-check > live-source-summary.json
```

The command fails closed if robots cannot be verified, the public endpoint changes, no China jobs are returned, or any application URL leaves the official ByteDance recruitment origin. On success, the JSON contains only counts, pagination, covered region codes, and five official-link samples; it excludes raw responses, descriptions, cookies, and CSRF tokens. `pagination.complete: false` is a valid, honest result when the upstream total exceeds the per-run safety budget.

The same check is available as `.github/workflows/live-source-audit.yml`. Run it manually, or add the `live-source-audit` label to a pull request; download the `oriole-live-source-*` artifact and validate `success`, `http.status`, `parserStats.observedRows`, `jobs.chinaObserved`, and `safety.previewOnly`.

## 7. Daily schedule verification

```bash
npm run daily
npm run daily
```

The second command on the same Beijing date should return `skipped: true`. Confirm that `.github/workflows/daily-oriole.yml` contains `cron: "0 16 * * *"`, equivalent to Beijing `00:00`.

A local run records `trigger: manual`. After publishing the repository, run or wait for the GitHub workflow, restore its resulting Registry/evidence, and confirm that the latest daily report has `trigger: github_actions` and `status: completed`. Only that evidence makes the audit's `scheduler_live` check pass.

## 8. Self-audit

```bash
npm run audit
node scripts/huangque/cli.mjs status
```

The audit deliberately distinguishes implementation/state checks from external activation checks. `fullyOperational` is true only when the current Registry has real jobs with evidence, complete graph evidence, successful live records for the configured external providers, and a successful GitHub Actions daily record. A fresh clone is expected to show blocked live checks until an operator collects current jobs, activates optional providers, and verifies the published schedule.

This is an honesty feature: code completeness and live data completeness are different claims.

## 9. Secret and release hygiene

Before publishing:

```bash
npm run secret-scan
git status --short
```

The first command must print `Secret scan passed.` and no finding. Confirm that `.openai/`, `.huangque/`, app/worker/database code, live snapshots, raw responses, `.env`, and credentials are absent from the public release.
