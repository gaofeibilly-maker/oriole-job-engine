# Architecture

Oriole separates discovery, trust, collection, normalization, graph storage, and Agent access. This separation is the main correctness boundary: a search result can propose a source, but it cannot become a trusted job feed by itself.

## Pipeline

```text
query plan
   │
   ├─ official catalog
   ├─ Baidu official API (optional)
   ├─ Common Crawl URL Index (keyless fallback)
   └─ operator / imported results
   │
   ▼
candidate source ── safe probe ── human review ── approved source
                                                 │
                                                 ▼
                                      guarded collection
                                                 │
                                                 ▼
                              normalize → locate → deduplicate
                                                 │
                        ┌────────────────────────┴──────────────────────┐
                        ▼                                               ▼
                portable Registry                           evidence artifacts
                        │
             CLI / MCP Agent / projection
```

## Deterministic core

The implementation uses Node.js built-ins and local JSON configuration. It has no runtime package dependencies.

- `engine.mjs` orchestrates discovery, probing, review, collection, due work, status, graph queries, and audit.
- `registry.mjs` owns lifecycle invariants, revision checks, atomic writes, cross-process locking, bounded history, job versions, and graph edges.
- `http.mjs` owns outbound safety. Callers do not fetch arbitrary URLs directly.
- `providers.mjs` implements discovery channels and preserves provider evidence.
- `query-plan.mjs` declares Provider capability per task, schedules only runnable tasks, and leaves unavailable work visible to the engine as blocked backlog.
- `probe.mjs` converts a candidate into verified or failed probe evidence without approving it; bounded directory and employer handoff links become separate candidates.
- `collector.mjs` collects only approved sources and defaults to preview unless `commit` is explicit.
- `adapters.mjs` recognizes supported feeds and produces `huangque.job.v2` jobs.
- `china-regions.mjs` supplies deterministic two-level workplace classification.
- `source-coverage.mjs` measures gaps across nine channels, 19 bounded employer targets, and the nationwide region taxonomy. It does not consume per-run pagination completeness; that remains separate collection evidence.
- `agent-tools.mjs` defines and validates the 16 MCP tool schemas.

## Persistence

The portable Registry is an atomically replaced JSON document. A sidecar lock serializes cross-process writers; mutations verify the expected revision where an operator decision could otherwise race. Raw collection responses can be stored as content-addressed gzip artifacts with SHA-256 hashes.

Default paths:

```text
.huangque/state.json
.huangque/state.json.lock
.huangque/artifacts/
.huangque/daily/
.huangque/latest-daily.json
.huangque/latest-audit.json
```

`latest-daily.json` is the authoritative atomic completion receipt used for daily idempotency. Files under `.huangque/daily/` are dated evidence archives and never cause a run to be skipped by themselves.

For production, place Registry and artifact paths on persistent storage by setting `HUANGQUE_REGISTRY_PATH` and `HUANGQUE_ARTIFACT_ROOT`. The GitHub Actions workflow uses a cache and audit artifacts as a convenient reference deployment; a cache is not a substitute for a production database or backup.

## Source lifecycle

```text
candidate ── probe success ──> probed ── approve ──> approved
    │                              │                     │
    └─ invalid evidence            └─ reject             └─ collect enabled
          or rejection                 ▼
                                    rejected
```

Invariants:

- only `approved + verified + collectionEnabled` sources can be collected;
- probing never approves;
- transient probe failures retry after a 24-hour backoff; explicit robots denial and access restriction remain blocked;
- approval requires reviewer, reason, confirmation, and the expected Registry revision;
- preview collection performs network and parser work but does not modify the job store;
- committed jobs retain source URLs, source IDs, evidence, versions, and graph relations.

### Clean-clone bootstrap

`data/huangque/verified-source-seeds.json` is a reviewed trust manifest, not a job snapshot. It contains nine public source identities, verification timestamps, publisher-controlled entry points, and zero jobs. `init` imports those sources as approved so the standalone Agent can collect on its first run; the daily runner source-key-syncs newly reviewed seeds without resetting Registry history. Adding or changing a verified seed is therefore equivalent to an operator approval and must receive source/evidence review. Ordinary discovery paths never write this file and never inherit its approval.

## Nationwide location model

The taxonomy contains 34 province-level entries and 365 prefecture/province-direct entries. Municipalities are displayed as a single first-level label such as `北京`; ordinary prefecture locations use labels such as `湖北省-武汉市`.

Classification reads structured work-location fields first. It preserves multiple explicit locations, but an ambiguous name such as `Suzhou, China` becomes `中国-地点待核验` instead of inventing both Jiangsu Suzhou and Anhui Suzhou; a province hint resolves the ambiguity. Search-query geography can support discovery, but it is not sufficient to label a job. Foreign-only rows are excluded. National and China-remote jobs use explicit national/remote representations rather than being assigned to a random city.

## Job identity and state

Strong identity uses canonical apply URLs and provider external IDs within the approved source boundary. Soft identity uses normalized title, organization, and location signals to create review candidates; it does not silently merge ambiguous jobs. Conflicting external IDs or cross-origin job URLs fail the collection.

Jobs keep observation times, validity dates, active/freshness scores, content versions, and missing observations. Authoritative complete feeds can advance missing-state thresholds; incomplete HTML/XML listings do not automatically close jobs.

## Source graph

Edges are materialized in the Registry with relation type, typed target, evidence, first/last observation, verification state, and run linkage.

| Relation | Meaning |
| --- | --- |
| `published_by` | source belongs to an identified publisher |
| `covers_region` | source evidence supports a national, province, or prefecture scope |
| `has_entry_point` | public page through which the source was discovered or accessed |
| `has_endpoint` | verified collection endpoint |
| `discovered_via` | provider/query/run that produced the source candidate |
| `lists_job` | approved source observed the normalized job |

Graph completeness is evidence-relative: every registered source gets all relations justified by its current evidence, and every edge is auditable. No finite seed catalog can prove that every employer or job in China has already been discovered.

An approved-source refresh is authoritative for publisher and declared coverage. The Registry replaces stale `published_by` and `covers_region` targets while retaining verified evidence against weaker rediscovery observations. Job collection adds coverage supported by actual structured work locations.

`list_regions` uses sets of job IDs so province totals are unique-job aggregates rather than the sum of city rows. It separately reports province-only jobs and per-city counts.

The bounded hosted projection is referentially closed: if a job is removed by row, count, or byte limits, its `lists_job` edge is removed too. External consumers never receive a graph edge pointing to a job absent from the same projection.

## MCP transport

`mcp-server.mjs` is a JSON-RPC 2.0 NDJSON stdio server. It supports the modern `2026-07-28` discovery flow and negotiates the initialized legacy lifecycle for `2025-11-25`, `2025-06-18`, and `2025-03-26`. It validates every tool argument against its declared schema, bounds structured output, enforces tool deadlines, and limits global and per-phase network requests.

Network tools execute only inside a controlled MCP operation context. Deadline cancellation propagates to the Registry run so an interrupted operation does not look successful.

Provider availability is also part of truthfulness: without Baidu, approved-source collection still runs, Common Crawl can run controlled `site:` tasks, and ordinary keyword discovery remains explicitly blocked in status/run evidence instead of being reported as completed.
