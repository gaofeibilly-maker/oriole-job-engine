# Oriole · 黄雀 Job Engine

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Sources](docs/SOURCES.md) · [Verification](docs/VERIFY.md)

**Turn the open web into a traceable, review-gated map of job sources—not an opaque pile of scraped listings.**

Oriole is an open, nationwide China job-source aggregation engine and Agent. It discovers public recruitment publishers, verifies their endpoints, requires human approval before collection, normalizes jobs by their actual workplace, and exposes the result through 18 bilingual MCP tools.

It is deliberately built as an engine, not a single website. Run it from the CLI, use the separate job-update and source-spider schedules, embed the deterministic core in another Node.js service, or connect it to an LLM client that supports MCP. “MCP-capable” is an integration requirement: Oriole does not make every LLM remotely usable automatically, and the client still needs local process access or an operator-provided transport.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Nationwide geography | Deterministic two-level China taxonomy: 34 province-level regions and 365 prefecture/province-direct entries |
| Workplace classification | Uses the job's stated work location, preserves multi-location jobs, supports province/city filters, and rejects foreign-only rows |
| Source discovery | A bounded 5,000+ employer universe built from four official directories plus 19 versioned priority employers, nine channels, Baidu Search API, Common Crawl URL Index, and submitted URLs |
| Stable collection | Lever, Greenhouse, Ashby, bounded ByteDance/Feishu Recruitment public search adapters with durable offset rotation, flexible public JSON, JSON-LD, RSS/Atom, Sitemap XML, and guarded HTML |
| Source graph | Evidence-bearing relations between publisher, source, region, entry point, endpoint, discovery channel, and job |
| Trust workflow | `candidate → probed → approved/rejected`; discovery and probing never auto-approve a source |
| Evidence and persistence | Run records, HTTP summaries, hashes, source/job traceability, and a complete durable state tree on `oriole-state`: the Registry gzip bundle/manifest, employer universe, spider queue, and receipts; compressed raw run evidence is retained separately as GitHub artifacts for 30 days |
| Agent interface | 18 bilingual MCP tools over JSON-RPC 2.0 NDJSON stdio; modern `2026-07-28` plus legacy `2025-11-25`, `2025-06-18`, and `2025-03-26` negotiation |
| Automation | Separate Beijing-time schedules: jobs daily at `00:17`; employer universe Sunday at `01:15`; source spider daily at `02:30`; deeper scan Sunday at `03:30`; recovery audit Sunday at `04:47` |
| Query coverage | 833 bounded discovery tasks: 730 prefecture-rotation tasks plus national, province, ATS, industry, park, and association work |
| Job freshness | The hosted current-job projection requires source-scoped evidence no older than 14 days; older Registry evidence is retained but is not advertised as fresh |
| Safety | HTTPS-only outbound access, public-address DNS pinning, SSRF defenses, redirect and robots guards, time/size/row limits, rate limits, and secret-host pinning |

## The source model

Discovery channels and job sources have different jobs:

- **Baidu** is a discovery radar. When configured, Oriole calls Baidu's official Qianfan endpoint and stores request-level evidence. It never scrapes a Baidu result page.
- **Common Crawl** is a keyless archive/index fallback for controlled `site:` patterns. It verifies that public URLs existed; it is not treated as a full-text search engine or as the final job source.
- **Official employer directories** define a bounded source-spider universe. The four authority inputs are SSE Main Board, SSE STAR Market, CNINFO's Shenzhen A-share disclosure-publisher directory, and the SASAC central-enterprise directory; the reviewed 19-employer inventory is versioned separately. The checked artifact contains 5,425 deduplicated targets. Its CNINFO scope explicitly includes current and historical publishers after excluding names clearly ending in `退`/`退市`; the SASAC request failed with HTTP 502 during this build, so its 99 entries are labelled as the versioned `2026-07-11` snapshot rather than live data.
- **Employer sites, official ATS boards, and government employment pages** are the long-lived collection targets. A source must pass safety probing and human review before its jobs can enter the Registry.
- **User submission** lets another Agent or operator propose a public URL, while keeping the same probe-and-review gate.

No Baidu key is required to collect the nine pre-approved source seeds or to discover candidates from the bundled official catalog. Provider capability is explicit per query task: ordinary keyword discovery is Baidu-only, so those tasks remain visibly `blocked` in `status.discoveryBacklog` and discovery-run statistics when Baidu is unavailable. Common Crawl is eligible only for controlled `site:` tasks; blocked work is never counted as completed.

The public repository ships **zero job records**. `npm run init` imports nine explicitly audited public source seeds—eight employer-controlled boards, including ByteDance, and one government employment source—so a clean clone has functional collection targets without publishing a stale or private job snapshot. This is not automatic approval of search results: the seed manifest itself is a reviewed trust decision, and all newly discovered sources still require probe and approval.

Coverage is a measurable gap report, not a claim of complete national job capture. The 5,000+ universe is a bounded discovery denominator, not 5,000+ approved job feeds. The source spider prioritizes missing and high-value employers, keeps persistent retry/backoff state, and can only create `candidate` or `probed` records. Every newly found source still needs a human approval before collection. The versioned ByteDance priority root is `https://jobs.bytedance.com/`; its reviewed experienced-hire listing remains the bootstrap collection entry.

ByteDance/Feishu collection is bounded to 50 pages, 5,000 upstream rows, and 24 MB per source invocation. When one invocation cannot reach the tail, a committed run stores a fingerprinted, generation-checked cursor under `source.collection.resume`; the next segment refreshes one head page and then continues the tail with one page of deliberate overlap. Job writes and cursor advancement share one atomic Registry transaction. Before either mutation, the Registry compare-and-swaps both the source revision read by the collector and the saved cursor generation; either conflict writes neither jobs nor cursor. Preview, failure, or a conflict never advances the saved position. A resumed tail segment remains `pagination.complete: false` even when it closes a rotation cycle, because a changing offset feed is not a cross-run snapshot and cannot justify missing-job closure. Inspect collection-run and Registry evidence separately: `npm run coverage` measures source/channel/region state and does not read pagination or resume progress.

The hosted projection applies a separate freshness boundary: a `confirmed_active` job needs qualifying source-scoped evidence within 14 days. A partial cursor segment cannot refresh jobs it did not observe. This filters the portable export; it does not erase older evidence from the complete Registry.

See [docs/SOURCES.md](docs/SOURCES.md) for the exact provider boundaries and seed catalog.

## Quick start

Requirements: Node.js `22.13+`. Oriole has no runtime dependencies and needs no secret to initialize or collect its pre-approved sources, discover from the official catalog, or run controlled Common Crawl `site:` tasks.

```bash
git clone https://github.com/gaofeibilly-maker/oriole-job-engine.git
cd oriole-job-engine
npm ci --ignore-scripts
npm test
npm run init
npm run status
npm run coverage
npm run regions -- --province-code 420000
```

After `init`, `status` should show 9 approved sources and 0 bundled jobs. Jobs only appear after a real committed collection.

For a preview-only, evidence-producing check of ByteDance's current public jobs (no Baidu key required), run `npm run live-source-check`. It validates official application URLs and prints a compact summary rather than raw responses or job descriptions. Preview reads the applicable window but never commits jobs or advances a saved resume cursor. The matching GitHub workflow can be run manually or by labeling a pull request `live-source-audit`.

Discover the bundled official catalog without a credential:

```bash
node scripts/huangque/cli.mjs discover \
  --providers official_catalog \
  --force

node scripts/huangque/cli.mjs sources
node scripts/huangque/cli.mjs graph
```

Discovery creates candidates; it does not silently turn them into collection targets. Probe a candidate, inspect its evidence and current Registry revision, then approve it explicitly:

```bash
node scripts/huangque/cli.mjs probe --source <source-id>

node scripts/huangque/cli.mjs review \
  --source <source-id> \
  --decision approve \
  --reviewer <operator-name> \
  --reason "Official public recruitment source verified" \
  --revision <current-revision> \
  --confirm

node scripts/huangque/cli.mjs collect --source <source-id> --commit
node scripts/huangque/cli.mjs jobs --province-code 420000 --city-code 420100
```

All state is local by default:

- `.huangque/state.json` — atomic portable Registry;
- `.huangque/artifacts/` — content-addressed, compressed evidence;
- `.huangque/source-spider-state.json` — persistent employer queue and backoff state;
- `.huangque/latest-job-update.json` and `.huangque/job-updates/` — latest and dated job-update receipts;
- `.huangque/latest-audit.json` — latest machine-readable self-audit.

These paths are ignored by Git and can be relocated with environment variables. The reference GitHub deployment stores the Registry as `registry.json.gz` plus a manifest containing compressed and plaintext SHA-256 values; plaintext `registry.json` is never committed. The same dedicated `oriole-state` tree also contains the validated employer universe, spider queue, and receipts. Compressed raw run evidence is uploaded separately with 30-day retention. The bundle code rejects compressed Registry data above 90 MiB (94,371,840 bytes), below the [official GitHub 100 MiB per-file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits). Deployments that approach this guard must move Registry storage to a database/object store rather than raising it.

## Initialize `oriole-state` once

The scheduled workflows cannot check out a branch that does not exist. Before the first Actions run, create a clean state branch from a disposable directory. These commands do not touch the current source branch, and the final push is intentionally **not** forced: if `oriole-state` already exists, it fails instead of overwriting durable state.

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

The staged inventory must contain exactly `employer-universe.json`, `registry.bundle-manifest.json`, `registry.json.gz`, and `source-spider-state.json`. The initialization summary must report nine approved reviewed seeds, zero jobs, zero runs, zero receipts, and no persisted plaintext Registry. This proves only that the durable state was initialized; it is not a successful online job update, source-spider run, or recovery exercise. Do not rerun this bootstrap to repair an existing branch—restore and audit the existing state instead.

## Connect an MCP-capable LLM client

Start the stdio server:

```bash
npm run mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "oriole": {
      "command": "node",
      "args": ["/absolute/path/oriole-job-engine/scripts/huangque/mcp-server.mjs"],
      "env": {
        "HUANGQUE_REGISTRY_PATH": "/absolute/path/oriole-data/state.json",
        "HUANGQUE_ARTIFACT_ROOT": "/absolute/path/oriole-data/artifacts"
      }
    }
  }
}
```

The 18 tools cover pipeline runs, run lookup, status, measurable source-coverage gaps, discovery, public-source submission, probing, source listing, job listing, region listing, graph reading, human review, collection, compatible due-job execution, the independent source spider, the independent job updater, audit, and portable projection export.

Network-tool defaults intentionally perform a small unit of work (for example, one employer or one due source) within the MCP deadline; callers can request a larger bounded batch or repeat the call. A failed or partial business result is returned with `isError: true` and `completed: false`, not labelled as successful merely because the process returned JSON.

The server is stdio MCP, not a public hosted endpoint. A compatible client must be configured to start the local process (as above), or an operator must provide a separate secured transport. Merely choosing an arbitrary LLM does not give it automatic remote access to Oriole.

`huangque.list_regions` reports unique-job aggregates at province level, province-only level, and each second-level city. A job explicitly offered in two cities in one province counts once in the province total and once in each applicable city.

Source approval through MCP is disabled by default. An operator must intentionally set `HUANGQUE_ALLOW_MCP_REVIEW=1`; CLI approval remains available without weakening that server-side boundary.

## Optional Baidu discovery

Copy the example configuration and set your key locally or as a GitHub Actions secret. Never commit it.

```bash
cp .env.example .env
export HUANGQUE_BAIDU_API_KEY="<your-key>"
node scripts/huangque/cli.mjs discover --providers baidu --max-queries 5
```

The key is only sent to `qianfan.baidubce.com`. A custom endpoint on another host is rejected. The default daily budget is 40 requests and can be lowered with `HUANGQUE_BAIDU_DAILY_BUDGET`.

Leaving Baidu unconfigured does not stop approved-source collection. It only leaves ordinary keyword-based active-discovery tasks explicitly blocked; keyless Common Crawl continues to handle the query plan's controlled `site:` tasks.

Official reference: [Baidu Qianfan AI Search API](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5).

## Independent schedules

The reference GitHub automation separates source discovery from job refresh:

| Beijing time | UTC cron | Work |
| --- | --- | --- |
| Daily `00:17` | `17 16 * * *` | Refresh due approved job sources only |
| Sunday `01:15` | `15 17 * * 6` | Atomically rebuild and validate the persistent employer universe |
| Daily `02:30` | `30 18 * * *` | Run the bounded source spider |
| Sunday `03:30` | `30 19 * * 6` | Run a deeper source/region gap scan |
| Sunday `04:47` | `47 20 * * 6` | Restore the complete `oriole-state` tree, verify its inventory and Registry bundle, run Agent status, and persist a recovery receipt |

Run the job updater locally with:

```bash
npm run daily
```

The runner writes a Beijing-date completion receipt, so a retry does not duplicate the same day's run unless `--force` is supplied. Run the source spider separately with `npm run source-spider`; use `-- --deep` only for the deeper mode. GitHub schedules can start late, so these are configured target times rather than proof that an online run occurred. See [docs/SCHEDULING.md](docs/SCHEDULING.md).

## Source graph, not just a list

Each graph edge carries evidence and observation timestamps. Core relations are:

```text
publisher ← published_by — source — covers_region → region
                            │
                            ├─ has_entry_point → public page
                            ├─ has_endpoint → collection endpoint
                            ├─ discovered_via → provider/query/run evidence
                            └─ lists_job → normalized job
```

Publisher and region edges follow the latest authoritative approved-source evidence: when an audited source identity changes, obsolete `published_by` and `covers_region` relations are pruned instead of remaining as misleading historical facts.

“Complete graph” here means that every registered source is represented with the relations supported by its evidence and that every relation is auditable. It does **not** mean the finite catalog already contains every employer or every open job in China; Oriole is designed to expand and re-verify that graph continuously.

## Verify before trusting

```bash
npm run verify
npm run audit
```

The test suite exercises normalization, the 5,000+ bounded universe contract, nationwide regions and 833 query tasks, multi-location handling, providers, bounded large-feed rotation, conditional GET, cursor atomicity/concurrency, graph evidence, Registry retention, state initialization/recovery, official-SDK MCP interoperability, SSRF controls, robots handling, source ownership, and job identity.

Keep these three claims separate:

1. **Implementation (`implementationComplete`)** says the code, workflow wiring, schemas, and safety contracts exist. Local tests and `stateIntegrityPassed` are supporting checks; neither is online evidence.
2. **Operational now (`operationalNow`)** says the current durable state contains real traceable jobs, graph and queue activity, recent real Provider observations, recent GitHub job/spider receipts, and a recent full-state recovery receipt. A configured cron, an initialized branch, a fixture, or a local run cannot satisfy it.
3. **Cross-day maturity (`maturityObserved`)** says successful GitHub job-update receipts and online-evidenced spider receipts cover at least two distinct Beijing natural dates. It measures repetition only and does not by itself imply that all current `operationalNow` recency checks still pass.

The v2.0.0 documentation describes implemented behavior; it does **not** claim that your GitHub workflows have already run successfully. Until the complete online checks pass, report “implemented/configured, operational verification pending.” Until both dated series cover two dates, separately report “cross-day maturity pending.” `fullyOperational` is true only when implementation, state integrity, operational-now, and maturity checks all pass.

Follow the reproducible checklist in [docs/VERIFY.md](docs/VERIFY.md).

## Boundaries

Oriole handles public, non-login web sources. It intentionally excludes private WeChat groups, image OCR, email inboxes, CAPTCHA/login-only pages, and other private channels. It does not apply for jobs or make employment decisions. Public web access does not waive a site's terms, robots policy, database rights, privacy obligations, or applicable law; deployers remain responsible for source-specific compliance.

## Project layout

```text
data/huangque/              verified seeds, employer universe, query/channel plans, public catalog
scripts/huangque/           CLI, independent updater/spider, MCP server, deterministic core
tests/                      Node test suite
docs/                       architecture, sources, schedule, verification
.github/workflows/          CI, employer refresh, separate job/source schedules, and full-state recovery audit
```

Contributions are welcome under [Apache-2.0](LICENSE). Please read [CONTRIBUTING.md](CONTRIBUTING.md) and report security issues through [SECURITY.md](SECURITY.md).
