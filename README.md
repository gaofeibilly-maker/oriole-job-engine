# Oriole · 黄雀 Job Engine

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Sources](docs/SOURCES.md) · [Verification](docs/VERIFY.md)

**Turn the open web into a traceable, review-gated map of job sources—not an opaque pile of scraped listings.**

Oriole is an open, nationwide China job-source intelligence Agent. It discovers public recruitment publishers, verifies their endpoints, requires human approval before collection, normalizes jobs by their actual workplace, and exposes the result to any LLM through 15 MCP tools.

It is deliberately built as an engine, not a single website. Run it from the CLI, schedule it at midnight, embed the deterministic core in another Node.js service, or connect an MCP-capable model without giving that model your credentials.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Nationwide geography | Deterministic two-level China taxonomy: 34 province-level regions and 365 prefecture/province-direct entries |
| Workplace classification | Uses the job's stated work location, preserves multi-location jobs, supports province/city filters, and rejects foreign-only rows |
| Source discovery | Eight audited public source seeds, official public directories, optional Baidu AI Search API, keyless Common Crawl URL Index, and user-supplied public URLs |
| Stable collection | Lever, Greenhouse, Ashby, flexible public JSON, JobPosting JSON-LD, RSS/Atom, Sitemap XML, and guarded HTML listings |
| Source graph | Evidence-bearing relations between publisher, source, region, entry point, endpoint, discovery channel, and job |
| Trust workflow | `candidate → probed → approved/rejected`; discovery and probing never auto-approve a source |
| Evidence | Run records, HTTP summaries, content hashes, compressed raw-response artifacts, source/job traceability, and machine-readable audits |
| Agent interface | 15 bilingual MCP tools over JSON-RPC 2.0 NDJSON stdio; modern `2026-07-28` plus legacy `2025-11-25`, `2025-06-18`, and `2025-03-26` negotiation |
| Daily operation | Idempotent Beijing-date runner and GitHub Actions schedule at `00:00 Asia/Shanghai` |
| Safety | HTTPS-only outbound access, public-address DNS pinning, SSRF defenses, redirect and robots guards, time/size/row limits, rate limits, and secret-host pinning |

## The source model

Discovery channels and job sources have different jobs:

- **Baidu** is a discovery radar. When configured, Oriole calls Baidu's official Qianfan endpoint and stores request-level evidence. It never scrapes a Baidu result page.
- **Common Crawl** is a keyless archive/index fallback for controlled `site:` patterns. It verifies that public URLs existed; it is not treated as a full-text search engine or as the final job source.
- **Public directories** seed authoritative national and local publishers, including national public employment, university employment, public institutions, central SOEs, and government department directories.
- **Employer sites, official ATS boards, and government employment pages** are the long-lived collection targets. A source must pass safety probing and human review before its jobs can enter the Registry.
- **User submission** lets another Agent or operator propose a public URL, while keeping the same probe-and-review gate.

No Baidu key is required to collect the eight pre-approved source seeds or to discover candidates from the bundled official catalog. Provider capability is explicit per query task: ordinary keyword discovery is Baidu-only, so those tasks remain visibly `blocked` in `status.discoveryBacklog` and discovery-run statistics when Baidu is unavailable. Common Crawl is eligible only for controlled `site:` tasks; blocked work is never counted as completed.

The public repository ships **zero job records**. `npm run init` imports eight explicitly audited public source seeds—seven employer-controlled ATS boards and one government employment source—so a clean clone has functional collection targets without publishing a stale or private job snapshot. This is not automatic approval of search results: the seed manifest itself is a reviewed trust decision, and all newly discovered sources still require probe and approval.

See [docs/SOURCES.md](docs/SOURCES.md) for the exact provider boundaries and seed catalog.

## Quick start

Requirements: Node.js `22.13+`. Oriole has no runtime dependencies and needs no secret to initialize or collect its pre-approved sources, discover from the official catalog, or run controlled Common Crawl `site:` tasks.

```bash
git clone https://github.com/gaofeibilly-maker/oriole-job-engine.git
cd oriole-job-engine
npm test
npm run init
npm run status
npm run regions -- --province-code 420000
```

After `init`, `status` should show 8 approved sources and 0 bundled jobs. Jobs only appear after a real committed collection.

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
- `.huangque/latest-audit.json` — latest machine-readable self-audit.

These paths are ignored by Git and can be relocated with environment variables.

## Connect any LLM through MCP

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

The server exposes tools for pipeline runs, run lookup, status, discovery, public-source submission, probing, source listing, job listing, region listing, graph reading, human review, collection, due work, audit, and portable projection export.

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

## Daily nationwide update at midnight

The bundled workflow runs at `16:00 UTC`, which is `00:00 Asia/Shanghai` on the next local calendar day:

```bash
npm run daily
```

The runner writes a Beijing-date completion marker, so a retry does not duplicate the same day's run unless `--force` is supplied. GitHub schedules can start a few minutes late; the local marker controls the business date, not the queue time. See [docs/SCHEDULING.md](docs/SCHEDULING.md).

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

The test suite exercises normalization, nationwide regions, multi-location handling, providers, graph evidence, Registry concurrency/retention, MCP lifecycle, SSRF controls, robots handling, source ownership, and job identity. The runtime audit separately reports whether external providers and the published GitHub schedule have real successful run evidence in the current Registry. Fixtures and a manual daily run never count as a live provider or GitHub Actions success.

Follow the reproducible checklist in [docs/VERIFY.md](docs/VERIFY.md).

## Boundaries

Oriole handles public, non-login web sources. It intentionally excludes private WeChat groups, image OCR, email inboxes, CAPTCHA/login-only pages, and other private channels. It does not apply for jobs or make employment decisions. Public web access does not waive a site's terms, robots policy, database rights, privacy obligations, or applicable law; deployers remain responsible for source-specific compliance.

## Project layout

```text
data/huangque/              verified public seeds, national query plan, and public catalog
scripts/huangque/           CLI, daily runner, MCP server, deterministic core
tests/                      Node test suite
docs/                       architecture, sources, schedule, verification
.github/workflows/          CI and Beijing-midnight daily update
```

Contributions are welcome under [Apache-2.0](LICENSE). Please read [CONTRIBUTING.md](CONTRIBUTING.md) and report security issues through [SECURITY.md](SECURITY.md).
