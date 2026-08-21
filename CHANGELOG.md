# Changelog

All notable changes to Oriole are documented here. The project follows semantic versioning.

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
