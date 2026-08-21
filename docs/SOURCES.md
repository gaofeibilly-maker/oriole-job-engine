# Sources and discovery channels

Oriole distinguishes three concepts:

1. a **discovery channel** that tells the engine where a possible source exists;
2. a **publisher/source** that is responsible for the public recruitment material;
3. a **collection endpoint** that can be safely and repeatedly read after approval.

Search results and archives never replace the final source evidence.

## Audited standalone seeds

`data/huangque/verified-source-seeds.json` makes a clean public clone functional without publishing jobs. It contains nine public, explicitly reviewed source identities and an empty `jobs` array:

- Xsolla and WeRide public Lever boards;
- Speechify and Fusion Worldwide public Greenhouse boards;
- Sensor Tower, adjoe, and Voodoo public Ashby boards;
- ByteDance's employer-controlled public experienced-hire board;
- Beijing's public employment service.

The manifest records its schema, review timestamp, public URL, provider, and the fact that it ships no job data. `init` imports these as verified and approved collection targets. Collection still runs through current DNS/HTTPS/robots/parser safeguards, and only jobs with a defensible China workplace survive normalization. A board's presence in the seed file does not imply that it currently has a China opening.

This file is the one reviewed-bootstrap exception to normal discovery flow. New search/catalog/user candidates are never auto-approved. Seed changes require code review and must not contain jobs, credentials, cookies, or raw responses.

## Hybrid source spider and measurable coverage

Oriole does not depend on one search engine or one hand-written site list. Its source spider is a controlled funnel:

1. versioned official directories and audited seeds supply authoritative starting points;
2. Baidu, Common Crawl, the 19-employer watchlist, and all 365 second-level region dimensions supply bounded discovery tasks that may yield public URLs;
3. URL identity logic collapses detail pages into stable source roots and recognizes supported ATS/custom public recruitment systems;
4. a bounded, persistent probe backlog checks HTTPS, DNS, redirects, robots, login/challenge signals, response budgets, and collection schema; transient failures retry after 24 hours;
5. verified candidates wait for human approval; weaker rediscovery evidence cannot downgrade or overwrite stronger evidence;
6. official directories and employer pages may emit bounded cross-origin source/ATS handoff clues, but every target becomes a separate unapproved candidate;
7. approved sources are collected on their own cadence, normalized by workplace, strongly deduplicated, and retained with evidence;
8. `npm run coverage` or MCP tool `huangque.source_coverage` reports what remains missing instead of claiming exhaustive web coverage.

The versioned plan in `data/huangque/source-channel-plan.json` measures nine complementary channel classes:

| Channel | Purpose | Default cadence |
| --- | --- | --- |
| Employer career sites | Primary, employer-controlled job source | 24 h |
| Public ATS | Stable public tenant/API source | 6 h |
| Government/public employment | National, provincial, and municipal official jobs | 12 h |
| Universities, parks, and associations | Local and sector gap filling | 24 h |
| Baidu official Search API | Keyword discovery radar | plan-driven |
| Common Crawl URL Index | Controlled `site:` URL/history gap filling | 7 d |
| Official public directories | Authoritative source discovery | 7 d |
| Sitemap, RSS, and Atom | Structured navigation or incremental feeds | 24 h |
| User submissions/imports | Event-driven public clues under the same review gate | on demand |

This is intentionally measurable rather than rhetorically “complete”: the current denominator is nine channel classes, 19 explicitly bounded major-employer targets, 34 province-level regions, and 365 second-level regions. A target is not counted as covered merely because a search result exists; collection coverage requires a verified, approved, enabled source.

The coverage report reads the versioned plan, source lifecycle/review state, query dimensions, and active jobs' structured work locations. It deliberately does **not** read a collection run's `pagination.complete` value, the persisted resume cursor, or a rotation cycle and turn them into a coverage score. Inspect Registry `collectionEvidence`, source `collection.resume`, and daily `sourceRuns` separately to understand bounded collection progress.

## Included discovery providers

### Official public catalog

The bundled discovery catalog is `data/huangque/public-source-catalog.json`. It is a maintained directory list, not a claim of exhaustive national coverage. The current catalog includes:

- China Public Recruitment (`job.mohrss.gov.cn`);
- National College Student Employment Service (`ncss.cn`);
- central and state public-institution recruitment (`mohrss.gov.cn`);
- central state-owned enterprise recruitment (`sasac.gov.cn`);
- the State Council's local department directory (`gov.cn`), used to discover provincial/municipal employment departments;
- Beijing public employment and public-institution seeds as tested local examples.
- ByteDance's official experienced-hire board.

The official-catalog provider also turns the other 18 entries in the versioned 19-employer watchlist into executable candidates. A clean run therefore sees 8 direct catalog entries plus 18 non-duplicate watchlist entries. These employer roots enter the persistent probe queue; they do not count as covered and cannot produce jobs until their endpoint and parser are verified and a human approves the source.

National entries declare all 34 province-level region codes as their intended discovery coverage. Local sources discovered from those directories still require their own probe and approval.

### Baidu official API

Provider name: `baidu`.

- Optional credential: `HUANGQUE_BAIDU_API_KEY`.
- Official endpoint: `https://qianfan.baidubce.com/v2/ai_search/web_search`.
- The request uses `baidu_search_v2`, safe search, a bounded web result count, and a bounded query length.
- Province/national queries do not inherit a Beijing fallback. A city constraint is only sent for a real city task.
- The key is refused if the configured endpoint host is not `qianfan.baidubce.com`.
- A Registry request budget limits daily use and records successful request evidence.

Oriole does not scrape Baidu result pages. See the [official Baidu API documentation](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5).

### Common Crawl URL Index

Provider name: `common_crawl`.

- No key is required.
- The provider first reads the official index directory at `https://index.commoncrawl.org/collinfo.json` and chooses the newest declared CDX API.
- Queries run only when the national query plan supplies a controlled `site:` domain pattern.
- Results are limited, collapsed by URL key, and filtered to successful HTML records.
- Stored evidence includes the archive index ID, digest, timestamp, and request URL.

Common Crawl is an archive URL index, not a general web-search replacement. Oriole never tries to translate an arbitrary keyword query into a full Common Crawl crawl. Keep request volume low and cache results in real deployments. Official references: [index collection list](https://index.commoncrawl.org/), [CDXJ index format](https://commoncrawl.org/cdxj-index), and [URL index guide](https://commoncrawl.org/url-index).

Query-plan tasks carry an explicit Provider capability list. Ordinary keyword tasks require `baidu`; controlled `site:` tasks may use `baidu` or `common_crawl`. If Baidu is not configured, keyword tasks stay in the visible blocked backlog and do not advance cadence. This has no effect on collecting already approved sources or importing the official catalog.

### User and imported results

`huangque.submit_source` and the CLI `submit` command accept an HTTPS public URL and create a candidate with submission evidence. Imported discovery results are supported by the deterministic provider adapter. Neither path bypasses safety probing or human review.

## National query plan

`data/huangque/national-query-plan.json` contains cadence buckets for:

- national official public employment and recruitment;
- all 34 province-level public employment and public-institution searches;
- rotating prefecture-city gap filling;
- public ATS domains;
- employer career sites by industry;
- industrial parks, associations, job fairs, and public gig-work markets.

The plan is versioned and tracks completed task IDs. A bucket advances its cadence only after its current task set completes.

## Supported collection formats

After probe and approval, the collector can normalize:

- Lever, Greenhouse, and Ashby public boards;
- ByteDance and compatible Feishu Recruitment public search APIs;
- flexible public JSON used by NCSS and government employment endpoints;
- Schema.org `JobPosting` JSON-LD;
- RSS and Atom feeds;
- Sitemap XML and XML job listings;
- bounded public HTML job listings.

Unsupported systems such as authenticated Workday instances may still be discovered as candidates, but they are not collected unless a safe public endpoint and adapter are added.

### ByteDance and Feishu Recruitment boundary

The ByteDance adapter follows the anonymous public website flow (`portal-channel: office`, `portal_type: 2`). Feishu Recruitment SaaS tenants use their separate public flow (`portal-channel: saas-career`, `portal_type: 6`). Both obtain an in-memory CSRF token and matching cookie from the same-origin public CSRF endpoint, then send bounded POST requests to the same-origin public job-search endpoint. Tokens and cookies are never written to the Registry, artifacts, logs, catalog, or source evidence. The normalized records retain the official job ID, title, publisher, all declared work cities, category, recruitment type, publish/expiry times, description, salary fields, and official detail URL.

The collector stops safely on CAPTCHA/risk-control responses, authentication requirements, `401`/`403`, persistent `405`, `429`, schema drift, robots denial, or response-budget exhaustion. It does not forge signatures, solve sliders, reuse a human session, or bypass access controls. A specific CSRF-expiry `405` may cause one fresh anonymous handshake and one retry; all other challenge behavior fails closed and remains visible in run evidence.

Large sources are deliberately bounded per invocation: at most 50 pages, 5,000 upstream rows, and 24 MB of accepted responses. For ByteDance and Feishu Recruitment, a committed bounded segment stores `source.collection.resume` with schema `huangque.collection-resume.v1`, an endpoint/request/trust-epoch fingerprint, a generation, the next offset, bounded segment history, and rotation-cycle evidence. A resumed segment spends one page of the same global budget refreshing offset zero, then continues at the saved tail with one upstream page of overlap. Offset progress uses raw upstream rows—not the number of jobs that survive China normalization.

The checkpoint is compared and advanced in the same atomic Registry transaction as the segment's jobs. Before any mutation, the collector's expected source revision must still match the approved source and the checkpoint generation must still match the committed cursor. Preview, HTTP/business/schema/identity failure, or either compare-and-swap conflict cannot advance the checkpoint or half-write jobs. A repeated or over-budget page is never counted as progress, although earlier safely accepted pages in the bounded segment may still produce a checkpoint. Endpoint/request/review-epoch changes invalidate the fingerprint; an in-flight collection from the old source revision is rejected, and a later collection restarts from the newly reviewed head. Gaps and repeated pages do not skip untrusted offsets; no-forward-progress state rotates safely back to zero without claiming completeness.

If an upstream advertises more rows—or returns an early gap/repeated page—the run stores safely accepted rows as `pagination.complete: false`, increments `sourcesIncomplete`, and never advances missing-job closure counters. A nonzero resumed segment remains incomplete even if `cycleEndReached` is true: a multi-run pass over a changing offset feed is progress evidence, not an authoritative snapshot. The result exposes `startOffset`, `observedEndOffset`, `nextOffset`, `headRefreshRows`, `tailRowsObserved`, `cursorFingerprint`, and the pre-commit `cursorGeneration`; the source Registry contains the committed next generation and offset. ByteDance discovery currently covers the experienced/social portal only, not campus hiring, internships, every ByteDance portal, or the entire web.

## Source inclusion policy

A source should be approved only when an operator can verify:

- a public HTTPS origin owned or controlled by the publisher or its official ATS;
- a recruitment-specific page or API endpoint;
- no login, CAPTCHA, private-group, or access-control bypass;
- robots and terms compatible with the intended access;
- an identifiable publisher and supported geographic scope;
- parseable jobs with source-owned apply URLs;
- evidence sufficient to explain how and when the source was found and verified.

Private WeChat groups, image-only posts, email, paid/private databases, and login-only sources are outside this release.

## Maintaining the catalog

Catalog changes must use public URLs, identify the publisher and authority, state the region or `CN`, and include the source page used as evidence. Run the full tests and then a real official-catalog discovery. Never place API keys, cookies, private source data, or copied job snapshots in the catalog.
