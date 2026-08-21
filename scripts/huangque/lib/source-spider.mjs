import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { discoverSourceCandidates } from "./source-discovery.mjs";
import { runDiscoveryProviders } from "./providers.mjs";
import { loadEmployerUniverse } from "./employer-universe.mjs";
import { fetchRobotsPolicy, robotsAllowsRules, safeFetch } from "./http.mjs";
import { extractPageSignals } from "./probe.mjs";

export const SOURCE_SPIDER_STATE_SCHEMA_VERSION = "huangque.source-spider-state.v1";
export const SOURCE_SPIDER_RUN_SCHEMA_VERSION = "huangque.source-spider-run.v1";

const MAX_RUN_HISTORY = 100;
const MAX_TARGET_EVIDENCE = 20;
const DAY = 86_400_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function iso(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("source spider 时间无效");
  return date.toISOString();
}

function beijingDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function emptyState(now = new Date()) {
  return {
    schemaVersion: SOURCE_SPIDER_STATE_SCHEMA_VERSION,
    revision: 0,
    createdAt: iso(now),
    updatedAt: iso(now),
    targets: {},
    runs: [],
  };
}

export function validateSourceSpiderState(value) {
  if (!value || value.schemaVersion !== SOURCE_SPIDER_STATE_SCHEMA_VERSION) {
    throw new TypeError(`寻源蜘蛛状态必须符合 ${SOURCE_SPIDER_STATE_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new TypeError("寻源蜘蛛 revision 无效");
  if (!value.targets || typeof value.targets !== "object" || Array.isArray(value.targets)) throw new TypeError("寻源蜘蛛 targets 无效");
  if (!Array.isArray(value.runs)) throw new TypeError("寻源蜘蛛 runs 无效");
  return value;
}

export async function readSourceSpiderState(path, now = new Date()) {
  try {
    return validateSourceSpiderState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(now);
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function acquireSourceSpiderStateLock(path, { timeoutMs = 8_000, staleMs = 120_000 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 8_000);
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = randomUUID();
      const owner = { pid: process.pid, hostname: hostname(), token, acquiredAt: new Date().toISOString() };
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      let heartbeat = Promise.resolve();
      const interval = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          let current;
          try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { return; }
          if (current?.token !== token) return;
          const now = new Date();
          await utimes(lockPath, now, now).catch(() => undefined);
        });
      }, Math.max(25, Math.floor(staleMs / 3)));
      interval.unref?.();
      return async () => {
        clearInterval(interval);
        await heartbeat.catch(() => undefined);
        await handle.close().catch(() => undefined);
        let current;
        try { current = JSON.parse(await readFile(lockPath, "utf8")); }
        catch (error) { if (error?.code === "ENOENT") return; throw error; }
        if (current?.token === token) await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const before = await stat(lockPath);
        if (Date.now() - before.mtimeMs > staleMs) {
          let owner = null;
          try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { owner = null; }
          let alive = false;
          if (owner?.hostname === hostname() && Number.isInteger(owner?.pid)) {
            try { process.kill(owner.pid, 0); alive = true; } catch (processError) { alive = processError?.code === "EPERM"; }
          }
          if (!alive) {
            const after = await stat(lockPath);
            if (after.mtimeMs === before.mtimeMs) {
              const current = await readFile(lockPath, "utf8").then((body) => JSON.parse(body)).catch(() => null);
              if (!owner?.token || current?.token === owner.token) {
                await unlink(lockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
                continue;
              }
            }
          }
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("寻源蜘蛛状态正被另一个运行更新，等待锁超时"), { code: "SOURCE_SPIDER_LOCK_TIMEOUT" });
      }
      await delay(15 + Math.floor(Math.random() * 35));
    }
  }
}

function targetOfficialRoot(target) {
  const value = target.officialRecruitmentUrl || target.officialWebsite || null;
  if (!value) return null;
  try {
    const url = new URL(value);
    // Employer crawling requires authenticated transport. An HTTP URL from an
    // official directory is upgraded and then independently verified; failure
    // enters backoff instead of silently falling back to plaintext.
    url.protocol = "https:";
    return url.toString();
  } catch { return null; }
}

function targetDomains(target) {
  const domains = new Set(asArray(target.officialDomains).map((value) => String(value).toLowerCase()).filter(Boolean));
  for (const value of [target.officialRecruitmentUrl, target.officialWebsite]) {
    try { domains.add(new URL(value).hostname.toLowerCase()); } catch { /* no trusted root yet */ }
  }
  return [...domains];
}

function boundedUrlEntries(values, limit = 100) {
  const output = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    if (!value?.url || seen.has(value.url)) continue;
    seen.add(value.url);
    output.push({ url: value.url, depth: Number(value.depth || 0), parentUrl: value.parentUrl || null });
    if (output.length >= limit) break;
  }
  return output;
}

function initializeCrawlState(previous, target) {
  const root = targetOfficialRoot(target);
  const visited = [...new Set(asArray(previous?.visitedUrls).map(String))].slice(-100);
  const frontier = boundedUrlEntries(previous?.frontier);
  if (root && !visited.includes(root) && !frontier.some((item) => item.url === root)) frontier.unshift({ url: root, depth: 0, parentUrl: null });
  return { visited, frontier: frontier.slice(0, 100), evidence: asArray(previous?.crawlEvidence).slice(-20) };
}

function sameOrigin(left, right) {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

async function crawlEmployerTargets(engine, selectedTargets, spiderState, {
  now,
  maxPages = 20,
} = {}) {
  const pageBudget = Math.max(0, Math.min(100, Number(maxPages) || 0));
  const queries = [];
  const observations = [];
  let pages = 0;
  for (const target of selectedTargets) {
    const previous = spiderState.targets[target.id] || {};
    const crawl = initializeCrawlState(previous, target);
    if (pages >= pageBudget || crawl.frontier.length === 0) {
      spiderState.targets[target.id] = { ...previous, frontier: crawl.frontier, visitedUrls: crawl.visited, crawlEvidence: crawl.evidence };
      continue;
    }
    const current = crawl.frontier.shift();
    if (current.depth > 2 || crawl.visited.includes(current.url)) {
      spiderState.targets[target.id] = {
        ...previous,
        frontier: boundedUrlEntries(crawl.frontier),
        visitedUrls: crawl.visited,
        crawlEvidence: crawl.evidence,
      };
      continue;
    }
    const observation = { employerTargetId: target.id, url: current.url, depth: current.depth, fetchedAt: iso(now) };
    try {
      const robots = await fetchRobotsPolicy(current.url, { ...engine.fetchOptions, requestPhase: "source_spider_crawl" });
      if (!robots.allowed) {
        const code = robots.reason === "robots_disallowed" ? "ROBOTS_DISALLOWED" : "ROBOTS_UNAVAILABLE";
        throw Object.assign(new Error(`robots: ${robots.reason}`), { code });
      }
      const response = await safeFetch(current.url, {
        ...engine.fetchOptions,
        requestPhase: "source_spider_crawl",
        maxBytes: 1_500_000,
        redirectGuard: ({ to }) => robotsAllowsRules(robots.rules || [], to),
      });
      pages += 1;
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: "CRAWL_HTTP_ERROR" });
      const artifact = engine.artifactStore ? await engine.artifactStore.put(response, {
        kind: "source_spider_response",
        employerTargetId: target.id,
        depth: current.depth,
      }) : null;
      const signals = extractPageSignals(response.body, response.finalUrl);
      const discovered = [
        ...signals.jobLinks.map((link) => ({ url: link.url, title: link.text || "招聘入口", kind: "recruitment_link" })),
        ...signals.edges.filter((edge) => ["feed", "sitemap"].includes(edge.type)).map((edge) => ({ url: edge.to, title: `${edge.type} 招聘索引`, kind: edge.type })),
      ];
      const root = targetOfficialRoot(target);
      for (const item of discovered.slice(0, 50)) {
        const owned = sameOrigin(item.url, root);
        if (owned && current.depth < 2 && !crawl.visited.includes(item.url) && !crawl.frontier.some((entry) => entry.url === item.url)) {
          crawl.frontier.push({ url: item.url, depth: current.depth + 1, parentUrl: current.url });
        }
      }
      if (discovered.length) queries.push({
        id: `employer-crawl:${target.id}:${createHash("sha256").update(current.url).digest("hex").slice(0, 10)}`,
        query: `${target.name} 官方网站内招聘入口`,
        dimensions: { employerTargetId: target.id, employerName: target.name, tier: target.tier },
        results: discovered.slice(0, 50).map((item, index) => ({
          title: item.title,
          snippet: `${target.name}权威目录网站内发现的公开招聘线索；仍需独立探测与审核。`,
          url: item.url,
          rank: index + 1,
          providerEvidence: {
            kind: sameOrigin(item.url, root) ? "official_employer_same_origin_link" : "official_employer_handoff",
            authority: sameOrigin(item.url, root) ? "official_employer" : "official_employer_handoff",
            publisher: target.name,
            sourcePage: current.url,
            employerTargetId: target.id,
            parentArtifact: artifact ? { observationId: artifact.observationId, contentHash: artifact.contentHash } : null,
          },
        })),
      });
      Object.assign(observation, {
        status: "ok",
        finalUrl: response.finalUrl,
        httpStatus: response.status,
        contentHash: response.contentHash,
        links: discovered.length,
        artifact: artifact ? { observationId: artifact.observationId, contentHash: artifact.contentHash } : null,
      });
    } catch (error) {
      pages += 1;
      Object.assign(observation, { status: "failed", code: error.code || "CRAWL_FAILED", error: error.message });
    }
    if (observation.status === "ok") {
      crawl.visited.push(current.url);
    } else if (observation.code !== "ROBOTS_DISALLOWED"
      && !crawl.frontier.some((item) => item.url === current.url)) {
      // Transient failures must remain retryable on a later scheduled run.
      // Each employer consumes at most one crawl item per run, so this cannot
      // create a same-run hot loop.
      crawl.frontier.push(current);
    }
    crawl.evidence.push(observation);
    spiderState.targets[target.id] = {
      ...previous,
      frontier: boundedUrlEntries(crawl.frontier),
      visitedUrls: [...new Set(crawl.visited)].slice(-100),
      crawlEvidence: crawl.evidence.slice(-20),
    };
    observations.push(observation);
  }
  return { pages, queries, observations };
}

function targetSourceMatches(source, target) {
  if (asArray(source?.candidate?.employerTargetIds).includes(target.id)) return true;
  const domains = targetDomains(target);
  const urls = [
    source?.candidate?.sourceRootUrl,
    source?.candidate?.entryUrl,
    source?.candidate?.publicApiUrl,
    source?.probe?.collectionEndpoint,
  ];
  return urls.some((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  });
}

function targetCoverage(target, registryState) {
  const sources = asArray(registryState.sources).filter((source) => targetSourceMatches(source, target));
  if (sources.some((source) => source.lifecycle === "approved" && source.verificationState === "verified" && source.collectionEnabled)) return "approved";
  if (sources.some((source) => source.verificationState === "verified")) return "verified_pending_review";
  if (sources.length) return "discovered";
  return "missing";
}

function targetSeenInJobs(target, registryState) {
  const names = [target.name, ...asArray(target.aliases)]
    .map((value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""))
    .filter((value) => value.length >= 2);
  return asArray(registryState.jobs).some((job) => {
    const company = String(job.company || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    return names.some((name) => company === name || company.includes(name) || name.includes(company));
  });
}

function targetPriority(target, registryState, spiderState, now) {
  const coverage = targetCoverage(target, registryState);
  const history = spiderState.targets[target.id] || {};
  const dueAt = history.nextDueAt ? new Date(history.nextDueAt) : null;
  const due = !dueAt || Number.isNaN(dueAt.getTime()) || dueAt <= now;
  const tierScore = target.tier === "A" ? 1_000 : target.tier === "B" ? 500 : 100;
  const coverageScore = coverage === "missing" ? 400
    : coverage === "discovered" ? 250
      : coverage === "verified_pending_review" ? 100 : 0;
  const jobGapScore = targetSeenInJobs(target, registryState) && coverage !== "approved" ? 500 : 0;
  const rootedScore = targetOfficialRoot(target) && coverage !== "approved" ? 150 : 0;
  const failurePenalty = Math.min(300, Number(history.consecutiveFailures || 0) * 30);
  return { coverage, due, score: tierScore + coverageScore + jobGapScore + rootedScore - failurePenalty };
}

export function selectEmployerTargets(universe, registryState, spiderState, {
  now = new Date(),
  maxEmployers = 100,
  deep = false,
} = {}) {
  const current = new Date(now);
  const limit = positiveInteger(maxEmployers, 100, 300);
  return universe.targets
    .map((target) => ({ target, ...targetPriority(target, registryState, spiderState, current) }))
    .filter((item) => item.due)
    .filter((item) => deep || item.coverage !== "approved")
    .sort((left, right) => right.score - left.score
      || String(left.target.tier).localeCompare(String(right.target.tier))
      || left.target.id.localeCompare(right.target.id))
    .slice(0, limit);
}

function rootImportedQuery(target) {
  const url = targetOfficialRoot(target);
  if (!url) return null;
  return {
    id: `employer-root:${target.id}`,
    query: `${target.name} 官方网站 招聘入口`,
    dimensions: { employerTargetId: target.id, employerName: target.name, tier: target.tier },
    results: [{
      title: target.officialRecruitmentUrl ? `${target.name}官方招聘` : `${target.name}官方网站`,
      snippet: `${target.name}的权威目录记录，用于发现公开招聘入口；不直接证明存在当前岗位。`,
      url,
      rank: 1,
      providerEvidence: {
        kind: target.officialRecruitmentUrl ? "reviewed_official_recruitment_root" : "official_employer_directory_root",
        authority: "official_employer",
        publisher: target.name,
        sourcePage: url,
        // The employer-universe is explicitly a China recruitment discovery
        // denominator. Carry that scope into deterministic candidate rules so
        // a reviewed public ATS root may be probed, while the Registry's human
        // approval gate still prevents automatic collection.
        regionCode: "CN",
        employerTargetId: target.id,
        directoryEvidence: asArray(target.evidence).slice(-3),
      },
    }],
  };
}

function searchTask(target) {
  const domains = targetDomains(target);
  const domain = domains[0] || null;
  return {
    id: `employer-search:${target.id}`,
    bucketId: "employer-source-spider",
    bucketLabel: "重点用人单位官方招聘入口",
    cadenceDays: target.tier === "A" ? 7 : 30,
    query: domain
      ? `site:${domain} 招聘 职位 career jobs`
      : `"${target.name}" 中国 官方招聘 社会招聘`,
    dimensions: {
      employerTargetId: target.id,
      employerName: target.name,
      employerOfficialDomain: domain,
      tier: target.tier,
      industry: target.industry || null,
      regionCode: target.regionCode || null,
    },
    providers: domain ? ["baidu", "common_crawl"] : ["baidu"],
  };
}

function mergeProviderInputs(outputs, observedAt) {
  const queries = [];
  const providerRuns = [];
  for (const output of outputs) {
    queries.push(...asArray(output.queries));
    providerRuns.push(...asArray(output.metadata?.providerRuns));
  }
  return {
    schemaVersion: "huangque.discovery-input.v1",
    metadata: { project: "黄雀", scope: "全国", provider: "employer_source_spider", observedAt, providerRuns },
    queries,
  };
}

function candidateTargetIds(candidate) {
  return asArray(candidate.employerTargetIds);
}

function sourceProbeIsDue(source, now) {
  if (source.collectionEnabled || source.candidate?.status !== "ready_for_probe") return false;
  if (source.lifecycle === "candidate"
    && source.reviewStatus === "unreviewed"
    && source.verificationState === "unverified_candidate") return true;
  if (source.lifecycle !== "probed" || source.verificationState !== "probe_failed") return false;
  const last = source.lastProbedAt ? new Date(source.lastProbedAt) : null;
  return Boolean(last && !Number.isNaN(last.getTime()) && now.getTime() - last.getTime() >= DAY);
}

function completedTaskIds(providerRuns) {
  return new Set(providerRuns.flatMap((run) => asArray(run.metadata?.completedTaskIds)));
}

function onlineProviderSucceeded(run) {
  if (run.provider === "baidu") return run.status === "ok" && Number(run.metadata?.requestCount || 0) > 0;
  if (run.provider === "common_crawl") return run.status === "ok" && Boolean(run.metadata?.indexId);
  return run.provider !== "imported" && run.status === "ok";
}

function providerSucceededForTarget(targetId, completed) {
  return completed.has(`employer-root:${targetId}`) || completed.has(`employer-search:${targetId}`);
}

function backoffDays(failures) {
  return Math.min(30, 2 ** Math.min(5, Math.max(0, failures - 1)));
}

function nextTargetState(previous, {
  now,
  success,
  coverage,
  sourceIds,
  providerStatuses,
}) {
  const attempts = Number(previous?.attempts || 0) + 1;
  const consecutiveFailures = success ? 0 : Number(previous?.consecutiveFailures || 0) + 1;
  const nextDays = coverage === "approved" ? 30
    : coverage === "discovered" && success ? 1
      : success ? 7 : backoffDays(consecutiveFailures);
  return {
    ...previous,
    attempts,
    consecutiveFailures,
    lastAttemptAt: iso(now),
    lastSuccessAt: success ? iso(now) : previous?.lastSuccessAt || null,
    nextDueAt: iso(new Date(new Date(now).getTime() + nextDays * DAY)),
    coverage,
    discoveredSourceIds: [...new Set([...asArray(previous?.discoveredSourceIds), ...sourceIds])].slice(-100),
    providerStatuses,
  };
}

export function sourceSpiderQueueSummary(universe, registryState, spiderState, now = new Date()) {
  const summary = { total: universe.targets.length, approved: 0, verifiedPendingReview: 0, discovered: 0, missing: 0, due: 0, backoff: 0 };
  for (const target of universe.targets) {
    const priority = targetPriority(target, registryState, spiderState, new Date(now));
    if (priority.coverage === "approved") summary.approved += 1;
    else if (priority.coverage === "verified_pending_review") summary.verifiedPendingReview += 1;
    else if (priority.coverage === "discovered") summary.discovered += 1;
    else summary.missing += 1;
    if (priority.due) summary.due += 1;
    else summary.backoff += 1;
  }
  return summary;
}

async function runSourceSpiderLocked(engine, {
  universePath,
  statePath,
  maxEmployers = 100,
  maxProbes = 20,
  maxCrawlPages = 20,
  deep = false,
  providers = ["baidu", "common_crawl"],
} = {}) {
  if (!engine?.registry || !universePath || !statePath) throw new TypeError("runSourceSpider 需要 engine、universePath 与 statePath");
  const now = new Date(engine.now());
  const observedAt = iso(now);
  const [universe, registryState, spiderState] = await Promise.all([
    loadEmployerUniverse(universePath),
    engine.registry.snapshot(),
    readSourceSpiderState(statePath, now),
  ]);
  for (const previousRun of spiderState.runs) {
    if (previousRun.status !== "pending_registry_commit") continue;
    const registryRun = registryState.runs.find((item) => item.id === previousRun.id);
    previousRun.status = registryRun && registryRun.status !== "running" ? registryRun.status : "interrupted";
    previousRun.reconciledAt = observedAt;
  }
  const selected = selectEmployerTargets(universe, registryState, spiderState, { now, maxEmployers, deep });
  const selectedTargets = selected.map((item) => item.target);
  const importedQueries = selectedTargets.map(rootImportedQuery).filter(Boolean);
  const tasks = selectedTargets.map(searchTask);
  const run = await engine.registry.createRun("source_spider", {
    deep,
    targetCount: universe.targets.length,
    selectedTargetIds: selectedTargets.map((target) => target.id),
    maxEmployers,
    maxProbes,
  });
  try {
    const crawl = await crawlEmployerTargets(engine, selectedTargets, spiderState, { now, maxPages: maxCrawlPages });
    const outputs = [];
    if (importedQueries.length || crawl.queries.length) {
      outputs.push(await runDiscoveryProviders([], {
        providers: ["imported"],
        importedInput: { schemaVersion: "huangque.discovery-input.v1", metadata: { observedAt }, queries: [...importedQueries, ...crawl.queries] },
        now,
      }));
    }
    if (tasks.length) {
      outputs.push(await runDiscoveryProviders(tasks, {
        providers,
        now,
        baidu: {
          ...engine.providerOptions.baidu,
          maxQueries: tasks.length,
          reserveRequest: () => engine.registry.reserveDailyProviderRequest("baidu", {
            limit: positiveInteger(process.env.HUANGQUE_BAIDU_DAILY_BUDGET, 100, 10_000),
            now: engine.now(),
          }),
          fetchOptions: { ...engine.fetchOptions, requestPhase: "source_spider" },
        },
        commonCrawl: {
          ...engine.providerOptions.commonCrawl,
          maxQueries: Math.min(tasks.length, deep ? 60 : 20),
          fetchOptions: { ...engine.fetchOptions, requestPhase: "source_spider" },
        },
      }));
    }
    const input = mergeProviderInputs(outputs, observedAt);
    if (input.queries.length === 0) input.queries.push({ id: "source-spider:no-output", query: "", channel: "none", results: [] });
    const discovery = discoverSourceCandidates(input, {
      knownSnapshot: {
        sources: registryState.sources.filter((source) => source.lifecycle === "approved").map((source) => ({
          id: source.id,
          name: source.name,
          provider: source.candidate?.provider || null,
          publicUrl: source.candidate?.sourceRootUrl,
        })),
      },
      observedAt,
    });
    await engine.registry.upsertCandidates(discovery, run.id);
    const afterDiscovery = await engine.registry.snapshot();
    const probeCandidates = afterDiscovery.sources
      .filter((source) => sourceProbeIsDue(source, now))
      .filter((source) => candidateTargetIds(source.candidate).some((id) => selectedTargets.some((target) => target.id === id)))
      .sort((left, right) => Number(right.candidate?.discoveryPriorityScore || 0) - Number(left.candidate?.discoveryPriorityScore || 0)
        || String(left.lastProbedAt || left.discoveredAt || "").localeCompare(String(right.lastProbedAt || right.discoveredAt || ""))
        || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, Number(maxProbes) || 0));
    const probes = [];
    for (const source of probeCandidates) probes.push(await engine.probeSource({ sourceId: source.id }));
    const finalRegistry = await engine.registry.snapshot();
    const successfulOnlineRuns = input.metadata.providerRuns.filter(onlineProviderSucceeded);
    const completed = completedTaskIds(successfulOnlineRuns);
    const providerStatuses = Object.fromEntries(input.metadata.providerRuns.map((item) => [item.provider, item.status]));
    for (const target of selectedTargets) {
      const sourceIds = finalRegistry.sources.filter((source) => targetSourceMatches(source, target)).map((source) => source.id);
      const coverage = targetCoverage(target, finalRegistry);
      const targetProbes = probes.filter((probe) => sourceIds.includes(probe.sourceId));
      // A real probe failure cannot be laundered into success merely because
      // its imported candidate URL now exists in the Registry.
      const successfulCrawl = crawl.observations.some((item) => item.employerTargetId === target.id && item.status === "ok");
      const success = targetProbes.length > 0
        ? targetProbes.some((probe) => probe.probe.verificationState === "verified")
        : successfulCrawl || providerSucceededForTarget(target.id, completed);
      spiderState.targets[target.id] = nextTargetState(spiderState.targets[target.id], {
        now,
        success,
        coverage,
        sourceIds,
        providerStatuses,
      });
    }
    const queue = sourceSpiderQueueSummary(universe, finalRegistry, spiderState, now);
    const successfulOnlineProviders = successfulOnlineRuns.map((item) => item.provider);
    const onlineEvidence = {
      present: successfulOnlineProviders.length > 0
        || crawl.observations.some((item) => item.status === "ok")
        || probes.some((item) => item.probe.verificationState === "verified"),
      successfulProviders: successfulOnlineProviders,
      successfulCrawlPages: crawl.observations.filter((item) => item.status === "ok").length,
      verifiedProbes: probes.filter((item) => item.probe.verificationState === "verified").length,
      note: "本地 imported 目标根只证明队列工作；不能替代真实网络成功证据。",
    };
    const report = {
      schemaVersion: SOURCE_SPIDER_RUN_SCHEMA_VERSION,
      runId: run.id,
      startedAt: observedAt,
      completedAt: iso(engine.now()),
      timezone: "Asia/Shanghai",
      scheduledDate: beijingDate(now),
      mode: deep ? "weekly_deep" : "daily",
      trigger: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "manual",
      githubRunId: process.env.GITHUB_RUN_ID || null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      universe: {
        schemaVersion: universe.schemaVersion,
        generatedAt: universe.generatedAt || universe.metadata?.generatedAt || null,
        targets: universe.targets.length,
        complete: universe.targets.length >= 5_000
          && universe.metadata?.completeness === "bounded_official_directory_universe",
      },
      selectedTargets: selectedTargets.length,
      selectedTargetIds: selectedTargets.map((target) => target.id),
      providerRuns: input.metadata.providerRuns,
      discovery: discovery.stats,
      crawl: { pages: crawl.pages, observations: crawl.observations },
      probes: probes.map((item) => ({ sourceId: item.sourceId, verificationState: item.probe.verificationState, runId: item.runId })),
      onlineEvidence,
      queue,
      approvalBoundary: "寻源蜘蛛只写 candidate/probed；任何新来源都不能自动进入 approved 岗位采集。",
      status: onlineEvidence.present ? "completed_with_findings" : selectedTargets.length === 0 ? "no_work" : "failed",
    };
    spiderState.revision += 1;
    spiderState.updatedAt = report.completedAt;
    const persistedRun = {
      id: run.id,
      at: report.completedAt,
      scheduledDate: report.scheduledDate,
      mode: report.mode,
      selectedTargets: report.selectedTargets,
      discoveredSources: discovery.stats.candidateSources,
      probes: probes.length,
      status: "pending_registry_commit",
      trigger: report.trigger,
      githubRunId: report.githubRunId,
      onlineEvidence: report.onlineEvidence,
    };
    spiderState.runs.unshift(persistedRun);
    spiderState.runs = spiderState.runs.slice(0, MAX_RUN_HISTORY);
    for (const targetState of Object.values(spiderState.targets)) {
      if (Array.isArray(targetState.evidence)) targetState.evidence = targetState.evidence.slice(-MAX_TARGET_EVIDENCE);
    }
    await atomicJson(statePath, spiderState);
    await engine.registry.finishRun(run.id, {
      status: report.status,
      stats: { selectedTargets: report.selectedTargets, ...discovery.stats, probes: probes.length, queue },
      providerRuns: input.metadata.providerRuns,
      errors: input.metadata.providerRuns.flatMap((item) => asArray(item.warnings).map((warning) => ({ provider: item.provider, warning }))),
      output: { sourceIds: discovery.candidates.map((candidate) => candidate.id), targetIds: report.selectedTargetIds },
    });
    persistedRun.status = report.status;
    persistedRun.registryCommittedAt = iso(engine.now());
    await atomicJson(statePath, spiderState);
    return report;
  } catch (error) {
    // Preserve the original failure. A failed Registry finalization leaves the
    // two-phase spider marker pending so the next run can reconcile it.
    await engine.registry.finishRun(run.id, { status: "failed", errors: [{ code: error.code || "SOURCE_SPIDER_FAILED", message: error.message }] }).catch(() => undefined);
    throw error;
  }
}

export async function runSourceSpider(engine, options = {}) {
  if (!engine?.registry || !options?.universePath || !options?.statePath) {
    throw new TypeError("runSourceSpider 需要 engine、universePath 与 statePath");
  }
  const release = await acquireSourceSpiderStateLock(options.statePath, {
    timeoutMs: options.lockTimeoutMs,
    staleMs: options.lockStaleMs,
  });
  try {
    return await runSourceSpiderLocked(engine, options);
  } finally {
    await release();
  }
}

export function sourceSpiderRunFingerprint(report) {
  return `sha256:${createHash("sha256").update(JSON.stringify(report)).digest("hex")}`;
}

const SUCCESSFUL_SPIDER_STATUSES = new Set(["completed", "completed_with_findings", "no_work"]);

export function combinedSourceSpiderStatus(spiderStatus, regionalGapScan = null) {
  if (!SUCCESSFUL_SPIDER_STATUSES.has(spiderStatus)) {
    return typeof spiderStatus === "string" ? spiderStatus : "failed";
  }
  if (regionalGapScan && !SUCCESSFUL_SPIDER_STATUSES.has(regionalGapScan.status)) return "partial";
  return spiderStatus;
}
