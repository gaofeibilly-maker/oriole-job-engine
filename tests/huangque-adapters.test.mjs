import assert from "node:assert/strict";
import test from "node:test";
import { dedupeJobs, normalizeAdapterPayload, parseSitemapIndexUrls, parseXmlListingJobs } from "../scripts/huangque/lib/adapters.mjs";
import { probeCandidate } from "../scripts/huangque/lib/probe.mjs";

test("ATS normalization keeps China jobs and excludes overseas jobs", () => {
  const source = {
    id: "source-lever",
    sourceKey: "ats:lever:global",
    name: "Global jobs",
    candidate: { provider: "Lever", tenant: "global", sourceType: "official_ats", scopeSignals: ["北京"], sourceRootUrl: "https://jobs.lever.co/global" },
    probe: { publisher: "Global Company" },
  };
  const response = {
    body: JSON.stringify([
      { id: "bj", text: "Beijing Analyst", categories: { location: "Beijing, China" }, hostedUrl: "https://jobs.lever.co/global/bj" },
      { id: "ny", text: "New York Analyst", categories: { location: "New York, USA" }, hostedUrl: "https://jobs.lever.co/global/ny" },
    ]),
    contentType: "application/json",
    finalUrl: "https://api.lever.co/v0/postings/global?mode=json",
  };
  const normalized = normalizeAdapterPayload(source, response, "2026-08-20T00:00:00.000Z");
  assert.deepEqual(normalized.jobs.map((job) => job.externalId), ["bj"]);
});

test("nationwide ATS scope accepts Shanghai from structured location", () => {
  const source = {
    id: "source-lever",
    sourceKey: "ats:lever:global",
    name: "Global jobs",
    candidate: { provider: "Lever", tenant: "global", sourceType: "official_ats", scopeSignals: ["北京"], sourceRootUrl: "https://jobs.lever.co/global" },
    probe: { publisher: "Global Company" },
  };
  const response = {
    body: JSON.stringify([{ id: "sh", text: "Shanghai Analyst", categories: { location: "Shanghai, China" }, descriptionPlain: "Work closely with our Beijing team", hostedUrl: "https://jobs.lever.co/global/sh" }]),
    contentType: "application/json",
    finalUrl: "https://api.lever.co/v0/postings/global?mode=json",
  };
  const jobs = normalizeAdapterPayload(source, response, "2026-08-20T00:00:00.000Z").jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].regionLabel, "上海");
});

test("unsupported ATS JSON never falls through to a generic source-scope adapter", () => {
  for (const provider of ["Workday", "SmartRecruiters"]) {
    const source = {
      id: `source-${provider}`,
      sourceKey: `ats:${provider}`,
      name: `${provider} jobs`,
      candidate: { provider, sourceType: "official_ats", scopeSignals: ["北京"], sourceRootUrl: `https://jobs.example.com/${provider}` },
    };
    const response = {
      body: JSON.stringify({ jobs: [{ id: "sh", title: "上海岗位", location: "上海", description: "北京团队协作", url: "https://jobs.example.com/sh" }] }),
      contentType: "application/json",
      finalUrl: `https://jobs.example.com/${provider}/api`,
    };
    const normalized = normalizeAdapterPayload(source, response, "2026-08-20T00:00:00.000Z");
    assert.equal(normalized.strategy, "unsupported_ats_json");
    assert.equal(normalized.jobs.length, 0);
  }
});

test("exact dedupe merges equal canonical apply URLs even across sources with external IDs", () => {
  const shared = "https://jobs.example.com/apply/1?utm_source=feed";
  const output = dedupeJobs([
    { id: "a", sourceId: "source-a", externalId: "ext-a", applyUrl: shared, authenticityScore: 90, evidence: [{ source: "a" }], company: "甲", title: "工程师", location: "北京" },
    { id: "b", sourceId: "source-b", externalId: "ext-b", applyUrl: "https://jobs.example.com/apply/1", authenticityScore: 99, evidence: [{ source: "b" }], company: "甲", title: "工程师", location: "北京" },
  ]);
  assert.equal(output.jobs.length, 1);
  assert.equal(output.jobs[0].id, "b");
  assert.equal(output.jobs[0].evidence.length, 2);
  assert.equal(output.stats.exactMerged, 1);
});

test("a source-list fallback URL never merges distinct external job IDs", () => {
  const source = {
    id: "ncss",
    sourceKey: "public:ncss",
    name: "NCSS",
    candidate: { provider: "NCSS", sourceType: "government_public_employment", sourceRootUrl: "https://job.ncss.cn/jobs" },
  };
  const response = {
    body: JSON.stringify({ data: { list: [
      { id: "one", jobName: "北京岗位一", companyName: "示例单位", areaName: "北京" },
      { id: "two", jobName: "北京岗位二", companyName: "示例单位", areaName: "北京" },
    ] } }),
    contentType: "application/json",
    finalUrl: "https://job.ncss.cn/api/jobs",
  };
  const normalized = normalizeAdapterPayload(source, response, "2026-08-20T00:00:00.000Z");
  assert.deepEqual(normalized.jobs.map((job) => job.urlIdentity), ["source_fallback", "source_fallback"]);
  const output = dedupeJobs(normalized.jobs);
  assert.equal(output.jobs.length, 2);
  assert.deepEqual(output.jobs.map((job) => job.externalId).sort(), ["one", "two"]);
});

test("RSS, Atom and Sitemap XML expose traceable recruitment entries", () => {
  const rss = `<rss><channel><item><title>北京招聘：运营经理</title><link>https://jobs.example.com/jobs/ops</link><pubDate>2026-08-20</pubDate><description>北京全职岗位</description></item></channel></rss>`;
  const sitemap = `<urlset><url><loc>https://jobs.example.com/careers/beijing-engineer</loc><lastmod>2026-08-19</lastmod></url></urlset>`;
  assert.equal(parseXmlListingJobs(rss, "https://jobs.example.com/feed.xml", "示例公司").length, 1);
  assert.equal(parseXmlListingJobs(sitemap, "https://jobs.example.com/sitemap.xml", "示例公司").length, 1);
});

test("sitemap indexes expose bounded child sitemap endpoints instead of fake jobs", () => {
  const sitemapIndex = `<sitemapindex><sitemap><loc>https://jobs.example.com/jobs-1.xml</loc></sitemap><sitemap><loc>/jobs-2.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemapIndexUrls(sitemapIndex, "https://jobs.example.com/sitemap.xml"), [
    "https://jobs.example.com/jobs-1.xml",
    "https://jobs.example.com/jobs-2.xml",
  ]);
  assert.equal(parseXmlListingJobs(sitemapIndex, "https://jobs.example.com/sitemap.xml", "示例公司").length, 0);
});

test("probe follows a discovered RSS endpoint and records it for collection", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://careers.example.com/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url === "https://careers.example.com/jobs") return new Response('<html><head><title>Careers</title><link rel="alternate" type="application/rss+xml" href="/jobs-feed.xml"></head></html>', { headers: { "content-type": "text/html" } });
    if (url === "https://careers.example.com/jobs-feed.xml") return new Response('<rss><channel><item><title>北京招聘：运营经理</title><link>https://careers.example.com/jobs/ops</link><description>北京全职岗位</description></item></channel></rss>', { headers: { "content-type": "application/rss+xml" } });
    throw new Error(`unexpected URL: ${url}`);
  };
  const probe = await probeCandidate({
    id: "rss-source",
    sourceRootUrl: "https://careers.example.com/jobs",
    scopeSignals: ["北京"],
  }, { fetchOptions: { fetchImpl, skipDns: true }, now: new Date("2026-08-20T00:00:00.000Z") });
  assert.equal(probe.verificationState, "verified");
  assert.equal(probe.collectionEndpoint, "https://careers.example.com/jobs-feed.xml");
  assert.equal(probe.strategy, "xml_feed_or_sitemap");
  assert.ok(probe.edges.some((edge) => edge.type === "feed"));
});

test("probe follows sitemap index children and records the concrete job sitemap", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://careers.example.com/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://careers.example.com/sitemap.xml\n", { headers: { "content-type": "text/plain" } });
    if (url === "https://careers.example.com/jobs") return new Response("<html><title>Careers</title></html>", { headers: { "content-type": "text/html" } });
    if (url === "https://careers.example.com/sitemap.xml") return new Response("<sitemapindex><sitemap><loc>https://careers.example.com/jobs.xml</loc></sitemap></sitemapindex>", { headers: { "content-type": "application/xml" } });
    if (url === "https://careers.example.com/jobs.xml") return new Response("<urlset><url><loc>https://careers.example.com/jobs/beijing-engineer</loc><lastmod>2026-08-19</lastmod></url></urlset>", { headers: { "content-type": "application/xml" } });
    throw new Error(`unexpected URL: ${url}`);
  };
  const probe = await probeCandidate({
    id: "sitemap-source",
    sourceRootUrl: "https://careers.example.com/jobs",
    scopeSignals: ["北京"],
  }, { fetchOptions: { fetchImpl, skipDns: true }, now: new Date("2026-08-20T00:00:00.000Z") });
  assert.equal(probe.verificationState, "verified");
  assert.equal(probe.collectionEndpoint, "https://careers.example.com/jobs.xml");
  assert.ok(probe.evidence.some((item) => item.kind === "sitemap_index_observation"));
});

test("JobPosting validity is independent from publication time and expired jobs close", () => {
  const source = {
    id: "jsonld",
    sourceKey: "jsonld",
    name: "示例公司",
    candidate: { sourceRootUrl: "https://jobs.example.com", scopeSignals: ["北京"] },
  };
  const response = {
    body: `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "北京工程师",
      hiringOrganization: { name: "示例公司" },
      jobLocation: { address: { addressLocality: "北京" } },
      validThrough: "2026-08-19",
      url: "https://jobs.example.com/expired",
    })}</script>`,
    contentType: "text/html",
    finalUrl: "https://jobs.example.com/expired",
  };
  const job = normalizeAdapterPayload(source, response, "2026-08-20T12:00:00.000Z").jobs[0];
  assert.equal(job.publishedAt, null);
  assert.equal(job.validThrough, "2026-08-19T23:59:59.999Z");
  assert.equal(job.status, "closed");
  assert.equal(job.activeScore, 0);
});

test("probe verifies a Shanghai JSON-LD job from its structured work location", async () => {
  const body = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Shanghai Engineer",
    hiringOrganization: { name: "Global Company" },
    jobLocation: { address: { addressLocality: "Shanghai" } },
    description: "Work closely with our Beijing team",
    url: "https://careers.example.com/jobs/shanghai",
  })}</script>`;
  const fetchImpl = async (url) => url.endsWith("/robots.txt")
    ? new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } })
    : new Response(body, { headers: { "content-type": "text/html" } });
  const probe = await probeCandidate({
    id: "workday-jsonld",
    provider: "Workday",
    sourceType: "official_ats",
    sourceRootUrl: "https://careers.example.com/jobs",
    scopeSignals: ["北京"],
  }, { fetchOptions: { fetchImpl, skipDns: true }, now: new Date("2026-08-20T00:00:00.000Z") });
  assert.equal(probe.verificationState, "verified");
  assert.equal(probe.counts.china, 1);
  assert.equal(probe.counts.beijing, 0);
});

test("salary and classification changes alter the canonical content hash", () => {
  const source = {
    id: "generic",
    sourceKey: "generic",
    name: "示例公司",
    candidate: { sourceRootUrl: "https://jobs.example.com", scopeSignals: ["北京"] },
  };
  const response = (salary, department = "运营") => ({
    body: JSON.stringify([{ id: "one", title: "运营经理", company: "示例公司", location: "北京", salary, department, url: "https://jobs.example.com/one" }]),
    contentType: "application/json",
    finalUrl: "https://jobs.example.com/api",
  });
  const first = normalizeAdapterPayload(source, response("8000 元/月"), "2026-08-20T00:00:00.000Z").jobs[0];
  const salaryChanged = normalizeAdapterPayload(source, response("12000 元/月"), "2026-08-20T00:00:00.000Z").jobs[0];
  const departmentChanged = normalizeAdapterPayload(source, response("8000 元/月", "战略运营"), "2026-08-20T00:00:00.000Z").jobs[0];
  assert.notEqual(first.contentHash, salaryChanged.contentHash);
  assert.notEqual(first.contentHash, departmentChanged.contentHash);
});
