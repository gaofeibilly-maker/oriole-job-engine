import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeUrl,
  deriveSourceIdentity,
  detectAts,
  discoverSourceCandidates,
  renderDiscoveryReport,
} from "../scripts/huangque/lib/source-discovery.mjs";

const observedAt = "2026-08-20T02:30:00.000Z";

function inputFor(results, query = "北京 招聘") {
  return {
    metadata: { scope: "北京", provider: "fixture", observedAt },
    queries: [{ id: "fixture-query", query, results }],
  };
}

test("canonicalizeUrl removes tracking but keeps meaningful filters", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://Jobs.Lever.co/weloglobal/?utm_source=test&location=Beijing%2C+China#jobs"),
    "https://jobs.lever.co/weloglobal?location=Beijing%2C+China",
  );
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
  assert.equal(canonicalizeUrl("not a url"), null);
  assert.equal(canonicalizeUrl("http://127.0.0.1/jobs"), null);
  assert.equal(canonicalizeUrl("https://user:secret@example.com/jobs"), null);
  assert.notEqual(
    canonicalizeUrl("https://boards.greenhouse.io/company/jobs?gh_jid=123&gh_src=search"),
    canonicalizeUrl("https://boards.greenhouse.io/company/jobs?gh_jid=456&gh_src=search"),
  );
});

test("ATS board, detail and API URLs resolve to one tenant source", () => {
  const board = deriveSourceIdentity("https://jobs.lever.co/weloglobal?location=Beijing");
  const detail = deriveSourceIdentity("https://jobs.lever.co/weloglobal/job-id/apply");
  const api = deriveSourceIdentity("https://api.lever.co/v0/postings/weloglobal?mode=json");
  assert.equal(board.sourceKey, "ats:lever:weloglobal");
  assert.equal(detail.sourceKey, board.sourceKey);
  assert.equal(api.sourceKey, board.sourceKey);
  assert.equal(api.publicApiUrl, "https://api.lever.co/v0/postings/weloglobal?mode=json");

  assert.deepEqual(
    detectAts("https://job-boards.greenhouse.io/appier/jobs/6783397"),
    {
      provider: "Greenhouse",
      tenant: "appier",
      sourceKey: "ats:greenhouse:appier",
      sourceRootUrl: "https://job-boards.greenhouse.io/appier",
      publicApiUrl: "https://boards-api.greenhouse.io/v1/boards/appier/jobs?content=false",
    },
  );
});

test("ByteDance list, detail and public search API resolve to one source", () => {
  const list = deriveSourceIdentity("https://jobs.bytedance.com/experienced/position");
  const detail = deriveSourceIdentity("https://jobs.bytedance.com/experienced/position/123456/detail?source=search");
  const api = deriveSourceIdentity("https://jobs.bytedance.com/api/v1/search/job/posts");
  assert.equal(list.sourceKey, "career:bytedance:jobs.bytedance.com");
  assert.equal(detail.sourceKey, list.sourceKey);
  assert.equal(api.sourceKey, list.sourceKey);
  assert.equal(list.provider, "ByteDance");
  assert.equal(list.publicApiUrl, "https://jobs.bytedance.com/api/v1/search/job/posts");

  const discovery = discoverSourceCandidates(inputFor([
    { title: "字节跳动社会招聘", snippet: "中国 北京 上海 招聘职位", url: list.canonicalUrl },
    { title: "后端工程师", snippet: "北京职位", url: detail.canonicalUrl },
  ], "字节跳动 中国 社会招聘"));
  assert.equal(discovery.stats.candidateSources, 1);
  assert.equal(discovery.candidates[0].status, "ready_for_probe");
  assert.equal(discovery.candidates[0].sourceType, "official_ats");
});

test("Feishu list, detail and API identities preserve observed portal paths", () => {
  const index = deriveSourceIdentity("https://nio.jobs.feishu.cn/index/position/list");
  const indexDetail = deriveSourceIdentity("https://nio.jobs.feishu.cn/index/position/7501226117869668619/detail");
  const campus = deriveSourceIdentity("https://nio.jobs.feishu.cn/campus/m/position/list");
  const campusDetail = deriveSourceIdentity("https://nio.jobs.feishu.cn/campus/position/7501226117869668619/detail");
  const numeric = deriveSourceIdentity("https://nio.jobs.feishu.cn/840753/position/7501226117869668619/detail");
  const api = deriveSourceIdentity("https://nio.jobs.feishu.cn/api/v1/search/job/posts");

  assert.equal(index.sourceRootUrl, "https://nio.jobs.feishu.cn/index");
  assert.equal(indexDetail.sourceRootUrl, index.sourceRootUrl);
  assert.equal(campus.sourceRootUrl, "https://nio.jobs.feishu.cn/campus");
  assert.equal(campusDetail.sourceRootUrl, campus.sourceRootUrl);
  assert.equal(numeric.sourceRootUrl, "https://nio.jobs.feishu.cn/840753");
  assert.equal(api.sourceRootUrl, "https://nio.jobs.feishu.cn/index");
  assert.equal(campus.portalPath, "campus");
  assert.equal(numeric.portalPath, "840753");
  assert.equal(api.portalPathObserved, false);
  assert.equal(new Set([index, indexDetail, campus, campusDetail, numeric, api].map((identity) => identity.sourceKey)).size, 1);

  const discovery = discoverSourceCandidates(inputFor([
    { title: "公开职位接口", snippet: "全国招聘职位", url: api.canonicalUrl, rank: 1 },
    { title: "校园招聘", snippet: "全国校园招聘职位", url: campus.canonicalUrl, rank: 2 },
  ], "NIO 全国校园招聘"));
  assert.equal(discovery.candidates[0].sourceRootUrl, "https://nio.jobs.feishu.cn/campus");
  assert.equal(discovery.candidates[0].portalPath, "campus");
});

test("generic career pages are origin-grouped but curated ownership is required for automatic probe", () => {
  const plain = discoverSourceCandidates(inputFor([
    { title: "示例公司招聘", snippet: "中国招聘职位", url: "https://careers.example.com/jobs" },
    { title: "北京工程师", snippet: "北京职位", url: "https://careers.example.com/jobs/123/detail" },
  ], "示例公司 中国 招聘"));
  assert.equal(plain.stats.candidateSources, 1);
  assert.equal(plain.candidates[0].sourceKey, "career:https://careers.example.com");
  assert.equal(plain.candidates[0].status, "needs_review");

  const curated = discoverSourceCandidates({
    metadata: { scope: "全国", provider: "official_catalog", observedAt },
    queries: [{
      id: "official-catalog:example",
      query: "全国 官方招聘目录",
      channel: "official_catalog",
      results: [{
        title: "示例公司官方招聘",
        snippet: "中国招聘职位",
        url: "https://careers.example.com/jobs",
        providerEvidence: { authority: "official_employer", sourcePage: "https://careers.example.com/jobs", region: "全国", regionCode: "CN" },
      }],
    }],
  });
  assert.equal(curated.candidates[0].status, "ready_for_probe");
  assert.ok(curated.candidates[0].decision.reasonCodes.includes("CURATED_OFFICIAL_EMPLOYER"));
});

test("a reviewed employer portal keeps its stable non-job path for probing", () => {
  const discovery = discoverSourceCandidates({
    metadata: { scope: "全国", provider: "official_catalog", observedAt },
    queries: [{
      id: "official-catalog:portal-employer",
      query: "全国 官方招聘目录",
      channel: "official_catalog",
      results: [{
        title: "示例企业官方招聘",
        snippet: "中国社会招聘职位",
        url: "https://job.example.com/portal/pc/",
        providerEvidence: {
          authority: "official_employer",
          sourcePage: "https://job.example.com/portal/pc/",
          region: "全国",
          regionCode: "CN",
        },
      }],
    }],
  });
  assert.equal(discovery.candidates[0].status, "ready_for_probe");
  assert.equal(discovery.candidates[0].sourceRootUrl, "https://job.example.com/portal/pc");
  assert.equal(discovery.candidates[0].endpointType, "job_list");
});

test("an official government directory becomes a bounded probe target rather than a job source", () => {
  const discovery = discoverSourceCandidates({
    metadata: { scope: "全国", provider: "official_catalog", observedAt },
    queries: [{
      id: "official-catalog:government-directory",
      query: "全国 官方招聘目录",
      channel: "official_catalog",
      results: [{
        title: "中国政府网地方部门目录",
        snippet: "用于发现地方人社、就业与公开招聘入口，不直接产出岗位。",
        url: "https://www.gov.cn/fuwu/bumendifangtingju.htm",
        providerEvidence: { authority: "official_government_directory", sourcePage: "https://www.gov.cn/fuwu/bumendifangtingju.htm", regionCode: "CN" },
      }],
    }],
  });
  assert.equal(discovery.candidates[0].sourceType, "official_source_directory");
  assert.equal(discovery.candidates[0].collectionStrategy, "bounded_directory_link_discovery");
  assert.equal(discovery.candidates[0].status, "ready_for_probe");
  assert.ok(discovery.candidates[0].decision.reasonCodes.includes("OFFICIAL_SOURCE_DIRECTORY"));
});

test("known sources are never reported as new", () => {
  const discovery = discoverSourceCandidates(
    inputFor([
      {
        title: "Xsolla Beijing jobs",
        snippet: "Official recruitment board with Beijing jobs",
        url: "https://jobs.lever.co/xsolla/some-job?utm_source=search",
      },
    ]),
    {
      knownSnapshot: {
        sources: [{ id: "lever-xsolla", name: "Xsolla 官方招聘", provider: "Lever", publicUrl: "https://jobs.lever.co/xsolla?location=Beijing" }],
      },
    },
  );
  assert.equal(discovery.stats.alreadyRegistered, 1);
  assert.equal(discovery.candidates[0].status, "already_registered");
  assert.equal(discovery.candidates[0].registryMatch.sourceId, "lever-xsolla");
  assert.equal(discovery.candidates[0].verificationState, "unverified_candidate");
});

test("a new public ATS tenant is ready for probe but never auto-approved", () => {
  const discovery = discoverSourceCandidates(inputFor([
    {
      title: "Account Manager - Beijing, China",
      snippet: "Appier official Greenhouse recruitment job in Beijing",
      url: "https://job-boards.greenhouse.io/appier/jobs/6783397",
    },
  ]));
  const [candidate] = discovery.candidates;
  assert.equal(candidate.status, "ready_for_probe");
  assert.equal(candidate.sourceType, "official_ats");
  assert.equal(candidate.endpointType, "api_feed");
  assert.equal(candidate.collectionStrategy, "public_ats_api");
  assert.equal(candidate.verificationState, "unverified_candidate");
  assert.match(candidate.nextAction, /探测公开 ATS 接口/);
});

test("NCSS Beijing JSON is recognized as a public-service API", () => {
  const discovery = discoverSourceCandidates(inputFor([
    {
      title: "国家大学生就业服务平台·北京职位",
      snippet: "北京 areaCode=11 公开招聘职位 JSON",
      url: "https://www.ncss.cn/student/jobs/jobslist/ajax/?areaCode=11&offset=1&limit=10",
    },
  ]));
  const [candidate] = discovery.candidates;
  assert.equal(candidate.status, "ready_for_probe");
  assert.equal(candidate.provider, "NCSS");
  assert.equal(candidate.sourceType, "government_public_employment");
  assert.equal(candidate.endpointType, "api_feed");
  assert.equal(candidate.collectionStrategy, "public_json_api");
  assert.match(candidate.nextAction, /公开 JSON/);
});

test("a recurring government list is separated from a single announcement", () => {
  const discovery = discoverSourceCandidates({
    metadata: { scope: "北京", provider: "fixture", observedAt },
    queries: [
      {
        id: "list-query",
        query: "北京 事业单位 招聘",
        results: [
          {
            title: "政务公开_事业单位公开招聘",
            snippet: "北京市人社局持续发布招聘岗位",
            url: "https://rsj.beijing.gov.cn/xxgk/gkzp/",
          },
          {
            title: "北京市朝阳区公开招聘公告",
            snippet: "北京招聘岗位附件",
            url: "https://rsj.beijing.gov.cn/xxgk/gkzp/202608/t20260805_4809286.html",
          },
        ],
      },
      {
        id: "single-query",
        query: "北京 支农 招聘",
        results: [
          {
            title: "北京市高校毕业生支农工作招聘公告",
            snippet: "北京公开招聘乡村振兴协理员",
            url: "https://rsj.beijing.gov.cn/xxgk/tzgg/202604/t20260414_4581613.html",
          },
        ],
      },
    ],
  });
  const list = discovery.candidates.find((candidate) => candidate.sourceRootUrl.endsWith("/xxgk/gkzp"));
  const single = discovery.candidates.find((candidate) => candidate.sourceRootUrl.endsWith("/xxgk/tzgg"));
  assert.equal(list.status, "ready_for_probe");
  assert.equal(list.endpointType, "job_list");
  assert.equal(single.status, "needs_review");
  assert.equal(single.endpointType, "detail");
  assert.ok(single.decision.reasonCodes.includes("SINGLE_POST_NEEDS_PARENT"));
});

test("a numbered government article stays review-only until a parent list is found", () => {
  const discovery = discoverSourceCandidates(inputFor([
    {
      title: "北京市各级机关2026年度考试录用公务员公告",
      snippet: "北京公务员招聘，岗位主体在附件中",
      url: "https://www.bjdj.gov.cn/article/3000206044.html",
    },
  ]));
  const [candidate] = discovery.candidates;
  assert.equal(candidate.status, "needs_review");
  assert.equal(candidate.endpointType, "detail");
});

test("community and park recruitment hubs are classified conservatively for human review", () => {
  const discovery = discoverSourceCandidates(inputFor([
    {
      title: "北京朝阳街道社区招聘栏目",
      snippet: "街道就业服务站持续归集社区岗位招聘信息",
      url: "https://community.example.com/jobs",
    },
    {
      title: "北京科技产业园招聘专栏",
      snippet: "园区企业岗位与商会招聘信息",
      url: "https://park.example.com/recruitment",
    },
  ]));
  const community = discovery.candidates.find((candidate) => candidate.sourceRootUrl.includes("community.example.com"));
  const park = discovery.candidates.find((candidate) => candidate.sourceRootUrl.includes("park.example.com"));
  assert.equal(community.sourceType, "community_recruitment_hub");
  assert.equal(park.sourceType, "park_or_association_board");
  assert.equal(community.status, "needs_review");
  assert.equal(park.status, "needs_review");
  assert.ok(community.decision.reasonCodes.includes("COMMUNITY_RECRUITMENT_HUB"));
  assert.ok(park.decision.reasonCodes.includes("PARK_OR_ASSOCIATION_BOARD"));
});

test("invalid URLs are isolated without aborting the batch", () => {
  const discovery = discoverSourceCandidates(inputFor([
    { title: "bad", snippet: "北京招聘", url: "not-a-url" },
    { title: "Welo Global jobs", snippet: "Beijing recruitment jobs", url: "https://jobs.lever.co/weloglobal" },
  ]));
  assert.equal(discovery.stats.inputResults, 2);
  assert.equal(discovery.stats.invalidResults, 1);
  assert.equal(discovery.stats.candidateSources, 1);
  assert.equal(discovery.invalidResults[0].reason, "invalid_or_unsupported_url");
});

test("malformed discovery input fails before producing a misleading empty run", () => {
  assert.throws(() => discoverSourceCandidates({}), /queries\[\] 或 results\[\]/);
  assert.throws(
    () => discoverSourceCandidates({ schemaVersion: "huangque.discovery-input.v99", results: [] }),
    /不支持的发现输入版本/,
  );
});

test("fixed input produces byte-stable JSON and report content", () => {
  const input = inputFor([
    { title: "Welo Global jobs", snippet: "Beijing recruitment jobs", url: "https://jobs.lever.co/weloglobal" },
  ]);
  const left = discoverSourceCandidates(input);
  const right = discoverSourceCandidates(input);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.equal(renderDiscoveryReport(left), renderDiscoveryReport(right));
  assert.match(renderDiscoveryReport(left), /不是来源可信度，也不是岗位有效性分数/);
});
