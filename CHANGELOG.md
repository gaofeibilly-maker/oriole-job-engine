# Changelog

All notable changes to Oriole are documented here. The project follows semantic versioning.

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
- `huangque.source_coverage` and `npm run coverage`, bringing the Agent interface to 16 MCP tools.
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
- Beijing-time idempotent daily runner and GitHub Actions schedule for 00:00 Asia/Shanghai.
- Node.js test suite covering regions, adapters, providers, Registry, MCP, network safety, identity, and source discovery.

### Security

- HTTPS-only outbound access, DNS pinning, private-address blocking, redirect and robots guards, time/size/row limits, source-origin boundaries, request budgets, and credential destination pinning.
