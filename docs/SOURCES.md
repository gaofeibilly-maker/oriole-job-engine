# Sources and discovery channels

Oriole distinguishes three concepts:

1. a **discovery channel** that tells the engine where a possible source exists;
2. a **publisher/source** that is responsible for the public recruitment material;
3. a **collection endpoint** that can be safely and repeatedly read after approval.

Search results and archives never replace the final source evidence.

## Audited standalone seeds

`data/huangque/verified-source-seeds.json` makes a clean public clone functional without publishing jobs. It contains eight public, explicitly reviewed source identities and an empty `jobs` array:

- Xsolla and WeRide public Lever boards;
- Speechify and Fusion Worldwide public Greenhouse boards;
- Sensor Tower, adjoe, and Voodoo public Ashby boards;
- Beijing's public employment service.

The manifest records its schema, review timestamp, public URL, provider, and the fact that it ships no job data. `init` imports these as verified and approved collection targets. Collection still runs through current DNS/HTTPS/robots/parser safeguards, and only jobs with a defensible China workplace survive normalization. A board's presence in the seed file does not imply that it currently has a China opening.

This file is the one reviewed-bootstrap exception to normal discovery flow. New search/catalog/user candidates are never auto-approved. Seed changes require code review and must not contain jobs, credentials, cookies, or raw responses.

## Included discovery providers

### Official public catalog

The bundled discovery catalog is `data/huangque/public-source-catalog.json`. It is a maintained directory list, not a claim of exhaustive national coverage. The first release includes:

- China Public Recruitment (`job.mohrss.gov.cn`);
- National College Student Employment Service (`ncss.cn`);
- central and state public-institution recruitment (`mohrss.gov.cn`);
- central state-owned enterprise recruitment (`sasac.gov.cn`);
- the State Council's local department directory (`gov.cn`), used to discover provincial/municipal employment departments;
- Beijing public employment and public-institution seeds as tested local examples.

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
- flexible public JSON used by NCSS and government employment endpoints;
- Schema.org `JobPosting` JSON-LD;
- RSS and Atom feeds;
- Sitemap XML and XML job listings;
- bounded public HTML job listings.

Unsupported systems such as authenticated Workday instances may still be discovered as candidates, but they are not collected unless a safe public endpoint and adapter are added.

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
