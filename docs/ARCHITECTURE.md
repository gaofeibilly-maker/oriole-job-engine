# Architecture

Oriole separates discovery, trust, collection, normalization, graph storage, and Agent access. This separation is the main correctness boundary: a search result can propose a source, but it cannot become a trusted job feed by itself.

## Pipeline

```text
5,000+ bounded employer universe ── source spider ────────┐
  ├─ four official directories                             │
  └─ 19 versioned priority roots                           │
                                                           ├─ candidate source
833-task nationwide query plan ── discovery providers ─────┤        │
  ├─ official catalog                                     │        ▼
  ├─ Baidu official API (optional)                         │    safe probe
  └─ Common Crawl URL Index                                │        │
                                                           │        ▼
operator / imported results ───────────────────────────────┘   human review
                                                                    │
                                                                    ▼
                                                             approved source
                                                 │
                                                 ▼
                                  independent job updater
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
- `employer-universe.mjs` validates the bounded 5,000+ target universe assembled from four official directories plus the versioned 19-employer priority inventory.
- `source-spider.mjs` maintains a persistent priority/backoff queue, crawls only bounded public employer roots, and can create candidates or probes but never approvals.
- `probe.mjs` converts a candidate into verified or failed probe evidence without approving it; bounded directory and employer handoff links become separate candidates.
- `collector.mjs` collects only approved sources and defaults to preview unless `commit` is explicit. Large ByteDance/Feishu offset feeds refresh one head page and resume a bounded, overlapping tail segment.
- `adapters.mjs` recognizes supported feeds and produces `huangque.job.v2` jobs.
- `china-regions.mjs` supplies deterministic two-level workplace classification.
- `source-coverage.mjs` measures gaps across nine channels, the 19 versioned priority employers, and the nationwide region taxonomy; the source spider separately tracks the full 5,000+ queue. Coverage does not consume per-run pagination completeness, which remains separate collection evidence.
- `hosted-projection.mjs` publishes only active jobs with qualifying source-scoped evidence no older than 14 days; the complete Registry remains the evidence authority.
- `agent-tools.mjs` defines and validates the 18 bilingual MCP tool schemas, including separate source-spider and job-update operations.

## Persistence

The portable Registry is an atomically replaced JSON document. A sidecar lock serializes cross-process writers; mutations verify the expected revision where an operator decision could otherwise race. The source-spider queue has its own lease lock because its network run spans a separate state file. ByteDance/Feishu sources keep an optional versioned cursor under `source.collection.resume`. Its fingerprint binds the provider endpoint, fixed request shape, and approval epoch. In the same transaction as the segment's job writes, the Registry compare-and-swaps both the source revision captured before network collection and the committed cursor generation. Either conflict aborts before job or cursor mutation. Successful Provider checkpoints are retained outside the bounded 50-run history so operational evidence does not disappear under normal collection volume. Raw collection responses can be stored as content-addressed gzip artifacts with SHA-256 hashes.

Default paths:

```text
.huangque/state.json
.huangque/state.json.lock
.huangque/artifacts/
.huangque/source-spider-state.json
.huangque/job-updates/
.huangque/source-spider-runs/
.huangque/latest-job-update.json
.huangque/latest-source-spider.json
.huangque/latest-state-recovery.json
.huangque/latest-audit.json
```

`latest-job-update.json` is the authoritative atomic completion receipt used for Beijing-date job-update idempotency. Files under `job-updates/` are dated evidence archives and never cause a run to be skipped by themselves. Source-spider queue state and dated spider receipts are separate so discovery failures cannot masquerade as job-refresh failures.

For production, place Registry and artifact paths on persistent storage by setting `HUANGQUE_REGISTRY_PATH` and `HUANGQUE_ARTIFACT_ROOT`. In the reference GitHub deployment, the Registry is packed as `registry.json.gz` with a manifest binding compressed bytes, plaintext bytes, schema, revision, and both SHA-256 values. The workflows unpack before use, repack afterward, refuse lock/temp/backup files, and never commit plaintext Registry state. The durable unit is the complete `state-data` tree, including the validated employer universe, source-spider queue, and receipts alongside the Registry bundle. All state writers share one queued group. The bundle has a 90 MiB compressed guard and a 512 MiB plaintext guard; the former stays below [GitHub's official 100 MiB per-file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits). Exceeding either fails closed and requires a real storage migration. A weekly recovery workflow copies the full state tree into isolation, verifies its deterministic inventory and Registry bundle, validates target/queue/receipt schemas, runs Agent status, and only then persists a machine-readable recovery receipt. It also compacts the dedicated state branch to one root commit with `--force-with-lease`, while raw run evidence remains a 30-day artifact. Operators should still apply an independent backup policy.

`oriole-state` is an explicit deployment prerequisite. `npm run init-state -- --output <empty-parent>/state-data` atomically creates exactly four durable bootstrap files: the checked employer universe, an empty spider-state document, and the reviewed nine-source/zero-job Registry as a gzip/manifest pair. It creates no job, run, or recovery receipt and never persists plaintext `registry.json`. The operator must commit that directory as the first root of `oriole-state`; the command does not create or overwrite the remote branch. See [SCHEDULING.md](SCHEDULING.md#first-time-oriole-state-initialization) for copyable commands.

## Independent automation loops

Job freshness and source coverage use separate loops:

- the job updater runs daily at `00:17 Asia/Shanghai` and only refreshes due `approved` sources;
- the bounded employer universe is rebuilt atomically Sunday at `01:15`; a failed refresh leaves the previous validated snapshot intact;
- the bounded source spider runs daily at `02:30` and never collects or approves newly found sources;
- a deeper source/region gap scan runs Sunday at `03:30`;
- state recovery is tested Sunday at `04:47`.

All four state-writing workflows share `oriole-state-writer`. These schedules are implementation/configuration facts; an actual online success requires persisted state and run evidence.

Three audit claims remain deliberately non-interchangeable: `implementationComplete` covers code/configuration, `operationalNow` covers the current durable data plus recent real Provider/GitHub/recovery evidence, and `maturityObserved` covers successful job and online-evidenced spider receipts on two distinct Beijing dates. Local tests and `stateIntegrityPassed` support those conclusions but never substitute for online evidence. Cross-day maturity is a repetition check, not a guarantee that every current recency check still passes; only `fullyOperational` requires all audit categories together.

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
- preview, failed collection, source-revision conflict, and cursor-generation conflict do not advance a persisted resume checkpoint or write segment jobs;
- every resumed ByteDance/Feishu segment refreshes the head, shares the same per-invocation safety budget, and overlaps one tail page;
- committed jobs retain source URLs, source IDs, evidence, versions, and graph relations.

### Clean-clone bootstrap

`data/huangque/verified-source-seeds.json` is a reviewed trust manifest, not a job snapshot. It contains nine public source identities, verification timestamps, publisher-controlled entry points, and zero jobs. `init` imports those sources as approved so the standalone Agent can collect on its first run; the daily runner source-key-syncs newly reviewed seeds without resetting Registry history. Adding or changing a verified seed is therefore equivalent to an operator approval and must receive source/evidence review. Ordinary discovery paths never write this file and never inherit its approval.

### Bounded employer universe

The source spider's denominator is a 5,000+ target artifact, not an assertion that all of those employers have approved job feeds. The checked file has 5,425 targets and merges four bounded authorities—SSE Main Board, SSE STAR Market, CNINFO's Shenzhen A-share disclosure-publisher directory (current plus historical publishers under the documented filter), and the SASAC central-enterprise directory—with 19 versioned, manually reviewed priority employers. Each source records `live`, `snapshot`, or `curated_snapshot`; the current SASAC contribution is explicitly a `2026-07-11` snapshot because its live build request failed. Proven aliases are deduplicated while provenance is retained. ByteDance's priority recruitment root is fixed to `https://jobs.bytedance.com/`.

Targets enter a persistent tier/coverage/backoff queue. Same-origin public crawling and discovery providers can propose career roots; successful probing still leaves the source pending human review. The spider contains no approval operation.

## Nationwide location model

The taxonomy contains 34 province-level entries and 365 prefecture/province-direct entries. The expanded query plan contains 833 tasks, including 730 prefecture-rotation tasks (two templates for every second-level entry). Municipalities are displayed as a single first-level label such as `北京`; ordinary prefecture locations use labels such as `湖北省-武汉市`.

Classification reads structured work-location fields first. It preserves multiple explicit locations, but an ambiguous name such as `Suzhou, China` becomes `中国-地点待核验` instead of inventing both Jiangsu Suzhou and Anhui Suzhou; a province hint resolves the ambiguity. Search-query geography can support discovery, but it is not sufficient to label a job. Foreign-only rows are excluded. National and China-remote jobs use explicit national/remote representations rather than being assigned to a random city.

## Job identity and state

Strong identity uses canonical apply URLs and provider external IDs within the approved source boundary. Soft identity uses normalized title, organization, and location signals to create review candidates; it does not silently merge ambiguous jobs. Conflicting external IDs or cross-origin job URLs fail the collection.

Jobs keep observation times, validity dates, active/freshness scores, content versions, and missing observations. Only an authoritative complete traversal that began at offset zero can advance missing-state thresholds. A resumed tail segment and a cross-run rotation cycle never close jobs merely because that bounded segment did not observe them; incomplete HTML/XML listings likewise do not automatically close jobs.

The hosted projection adds a 14-day source-scoped freshness rule. An active job needs a recent per-job observation, or for a non-cursor source a correlated authoritative full collection/HTTP 304 check. Partial cursor work never renews unseen jobs. This affects what is advertised through the bounded hosted snapshot; it does not delete historical Registry evidence.

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

`mcp-server.mjs` is a JSON-RPC 2.0 NDJSON stdio server exposing 18 bilingual tools. It supports the modern `2026-07-28` discovery flow and negotiates the initialized legacy lifecycle for `2025-11-25`, `2025-06-18`, and `2025-03-26`. It validates every tool argument against its declared schema, bounds structured output, enforces tool deadlines, and limits global and per-phase network requests.

Any LLM client that supports MCP can use the Agent after it is explicitly configured to start this stdio process (or after an operator supplies another secured transport). Oriole does not automatically expose a remote endpoint to every LLM.

Network tools execute only inside a controlled MCP operation context. Deadline cancellation propagates to the Registry run so an interrupted operation does not look successful.

Provider availability is also part of truthfulness: without Baidu, approved-source collection still runs, Common Crawl can run controlled `site:` tasks, and ordinary keyword discovery remains explicitly blocked in status/run evidence instead of being reported as completed.
