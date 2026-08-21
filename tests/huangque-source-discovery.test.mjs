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
      publicApiUrl: "https://boards-api.greenhouse.io/v1/boards/appier/jobs?content=true",
    },
  );
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
