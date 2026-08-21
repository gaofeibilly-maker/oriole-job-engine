# Changelog

All notable changes to Oriole are documented here. The project follows semantic versioning.

## 2.0.0 — 2026-08-21

Nationwide bounded employer-universe, independent source-spider/job-update, and durable-state release.

### Added

- A validated 5,425-employer target universe assembled from SSE Main Board, SSE STAR Market, CNINFO's Shenzhen A-share disclosure-publisher directory, the SASAC central-enterprise directory, and 19 versioned reviewed priority employers. Every contribution is labelled `live`, `snapshot`, or `curated_snapshot`; ByteDance's priority recruitment root is fixed to `https://jobs.bytedance.com/`.
- A persistent tier/coverage/backoff source-spider queue with same-origin bounded crawling. New findings can become candidates or probes but can never bypass human approval.
- Separate bilingual MCP tools for source-spider and job-update execution, bringing the stdio Agent interface to 18 tools for MCP-capable LLM clients.
- Reference workflow support for complete durable `oriole-state` persistence: a SHA-256-manifested Registry gzip bundle, employer universe, spider state, and receipts; fixed staging allowlists; shared queued writer concurrency; weekly force-with-lease history compaction; 30-day GitHub raw-evidence artifacts; and a full-state recovery workflow with a machine-readable receipt.
- A fail-closed `npm run init-state -- --output <empty-parent>/state-data` bootstrap that creates only the validated employer universe, empty spider state, and the reviewed nine-source/zero-job Registry gzip/manifest pair. It creates no online receipt and does not create or overwrite the remote branch.
- A 90 MiB compressed Registry guard and 512 MiB plaintext guard. The compressed ceiling stays below [GitHub's documented 100 MiB regular-file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits) and fails instead of presenting Git as unbounded storage.
- Persistent per-Provider success checkpoints that survive bounded run-history pruning, plus an independent lease lock for concurrent source-spider state writers.
- Conditional GET support with persisted ETag/Last-Modified validators, bounded Retry-After handling, and an HTTP 304 transaction that never advances missing-job or cursor state.
- A 14-day source-scoped freshness requirement for confirmed-active jobs in the hosted projection.
- Explicit, non-interchangeable audit conclusions for implementation, recent online operation, and two-natural-day maturity, with state integrity reported independently and `fullyOperational` requiring every category.

### Changed

- Oriole is described consistently as a nationwide job-source aggregation engine and Agent, rather than as a single scraper or job board.
- The expanded national plan is fixed at 833 discovery tasks: 730 prefecture-rotation tasks plus national, province, ATS, industry, park, and association work across nine channels.
- Automation is split into Beijing-time job refresh at `00:17`, Sunday employer-universe refresh at `01:15`, daily source discovery at `02:30`, Sunday deep scan at `03:30`, and Sunday recovery audit at `04:47`.
- Daily idempotency receipts are now `latest-job-update.json` plus dated `job-updates/`; source-spider queue and receipts are maintained independently.

### Security

- The spider cannot approve sources, source approval remains revision/reviewer/reason/confirmation gated, and MCP approval remains disabled by default.
- Hosted output does not advertise jobs whose qualifying source evidence is older than 14 days. Partial cursor segments cannot refresh unseen jobs.
- Recovery, validator, Registry, host, robots, origin, artifact, and secret-destination checks fail closed.

### Verification status

- This changelog records implemented release behavior, not a claim that a particular deployment is online. `implementationComplete` requires the checked code/configuration; `operationalNow` additionally requires current real jobs/graph/queue data, recent Provider evidence, recent GitHub job/spider evidence, and a recent verified full-state recovery; `maturityObserved` separately requires successful GitHub job-update and online-evidenced spider receipts on at least two distinct Beijing dates. Initialization, fixtures, local tests, configured cron, and one online run cannot be substituted across those claims.

## 1.1.1 — 2026-08-20

Bounded large-feed rotation and durable resume release.

### Added

- Persistent `source.collection.resume` checkpoints for ByteDance and Feishu Recruitment, bound to the approved endpoint, fixed request shape, and review epoch by a SHA-256 fingerprint.
- A fresh-head page on every resumed segment plus a one-page tail overlap, making deep offsets reachable over successive committed runs without starving newly inserted head jobs.
- Source-revision and cursor-generation compare-and-swap checks in the same Registry transaction as job writes, with bounded cycle and segment evidence. Either conflict aborts before any job or cursor mutation.

### Changed

- The 50-page, 5,000-row, and 24 MB limits now apply to the combined head-refresh and resumed-tail work of each source invocation.
- Preview, failed, or conflicted work cannot advance the committed cursor. A repeated or unaccepted over-budget page is never counted as progress, although earlier accepted pages in that bounded segment may still produce a checkpoint. Reaching the tail from a nonzero offset remains incomplete and never advances missing-job closure.
- Package metadata, MCP `serverInfo`, CLI banner, and outbound HTTP User-Agent now identify release `1.1.1`.

### Security

- Malformed, stale, cross-endpoint, or concurrently superseded checkpoints fail closed. A source changed after the collector snapshot is rejected by source-revision CAS before job mutation; a later run restarts from the newly reviewed head. Anonymous CSRF tokens and cookies remain memory-only.

## 1.1.0 — 2026-08-20

Source-spider and major-employer coverage-measurement release.

### Added

- ByteDance and Feishu Recruitment public search adapters with provider-specific anonymous CSRF sessions, pagination, multi-location normalization, and canonical detail URLs.
- A versioned nine-channel source plan and bounded watchlist of 19 major employers across internet, technology, manufacturing, and central state-owned groups.
- Executable watchlist discovery, bounded official-directory expansion, and cross-origin employer ATS handoff candidates under the existing probe/review gate.
- Explicit 34-province and 365-second-level discovery dimensions, persistent probe backlog, and 24-hour retry for transient probe failures.
- `huangque.source_coverage` and `npm run coverage`, expanding the then-current MCP interface by one tool.
- Persisted per-source pagination, parser, HTTP, storage, and anonymous-session summaries for independent run verification.

### Changed

- Clean-clone bootstrap now contains nine reviewed sources and zero jobs, including ByteDance's official experienced-hire source.
- Large feeds stop as explicit bounded/incomplete observations instead of discarding every safely parsed prior page; incomplete feeds never advance missing-job closures.
- Employer, channel, and region coverage now distinguish discovered, verified, approved, and current-job evidence. Per-run pagination completeness remains separate collection evidence and is not folded into the source-coverage score.
- MCP `serverInfo` and the outbound HTTP User-Agent now identify release `1.1.0` consistently with the package metadata.

### Security

- Public recruitment tokens/cookies remain memory-only; risk-control challenges, schema drift, business errors, robots failures, and cross-origin job URLs fail closed.

## 1.0.0 — 2026-08-20

First public Agent release.

### Added

- Nationwide China workplace taxonomy with 34 province-level regions and 365 second-level entries.
- Audited clean-clone bootstrap with eight public approved sources and zero bundled jobs.
- Structured `huangque.job.v2` locations, multi-location preservation, and province/city filtering.
- Official catalog, Baidu official API, Common Crawl URL Index, imported result, and user-submission discovery paths.
- Evidence-backed source graph relations: `published_by`, `covers_region`, `has_entry_point`, `has_endpoint`, `discovered_via`, and `lists_job`.
- Human-gated source lifecycle and preview-by-default collection.
- Fifteen bilingual MCP tools, complete CLI, atomic JSON Registry, compressed evidence store, and machine-readable audit.
- MCP negotiation for modern `2026-07-28` and legacy `2025-11-25`, `2025-06-18`, and `2025-03-26` clients.
- Unique province/province-only/city job aggregates, authoritative publisher/coverage pruning, and dangling-edge-free hosted projections.
- Per-query Provider capability and explicit blocked discovery backlog when Baidu-only keyword work is unavailable; Common Crawl remains limited to controlled `site:` tasks.
- Beijing-time idempotent daily runner and the original reference schedule, superseded by the separated 2.0.0 schedules above.
- Node.js test suite covering regions, adapters, providers, Registry, MCP, network safety, identity, and source discovery.

### Security

- HTTPS-only outbound access, DNS pinning, private-address blocking, redirect and robots guards, time/size/row limits, source-origin boundaries, request budgets, and credential destination pinning.
