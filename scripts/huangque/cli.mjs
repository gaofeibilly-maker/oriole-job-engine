#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { HuangqueEngine } from "./lib/engine.mjs";
import { huangqueToolResultOutcome } from "./lib/agent-tools.mjs";

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const booleanOptions = new Set(["help", "force", "confirm", "commit", "collectApproved", "deep"]);
const executionToolByCommand = new Map([
  ["discover", "huangque.discover_sources"],
  ["collect", "huangque.collect_jobs"],
  ["pipeline", "huangque.run_pipeline"],
  ["source-spider", "huangque.run_source_spider"],
  ["job-update", "huangque.run_job_update"],
  ["run-due", "huangque.run_due"],
]);

function usage() {
  return `黄雀 2.0.0：岗位垂类的信息源归集引擎

用法：node scripts/huangque/cli.mjs <command> [options]

命令：
  init                         导入已审核来源种子（兼容可选历史快照）
  status                       显示来源图谱、岗位与到期查询桶
  coverage                     显示渠道、重点企业和全国地域覆盖缺口
  discover                     执行多 Provider 来源发现
  submit --url <url>           提交一个公开来源候选
  probe --source <id>          安全探测候选（也可 --url）
  sources                      查询来源 Registry
  review --source <id>         approve/reject（需 revision/reviewer/reason/confirm）
  collect [--source <id>]      采集 approved 来源；默认 preview，--commit 才写入
  pipeline                     发现→探测；新来源不会自动批准
  source-spider                按持久队列寻源；--deep 提高深扫预算
  job-update                   只更新到期的 approved 岗位源
  run-due                      job-update 的兼容别名
  jobs                         查询黄雀岗位库（可按省市代码筛选）
  regions                      查询全国省级—地级二级地区目录
  graph                        查询有证据的招聘源图谱关系
  get-run --run <id>           查看运行记录
  export-hosted [--output]     生成可同步到外部托管系统的有界投影
  audit [--output <path>]      生成可机器读取的自审报告

地区筛选：--province-code <六位代码> --city-code <六位代码>
全局：--registry <path> --artifact-root <path> --project-root <path>
`;
}

function parse(argv) {
  const command = argv[0];
  const options = { _: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { options._.push(arg); continue; }
    const rawOption = arg.slice(2);
    const equalsAt = rawOption.indexOf("=");
    const rawKey = equalsAt === -1 ? rawOption : rawOption.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : rawOption.slice(equalsAt + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (booleanOptions.has(key)) {
      const explicitValue = inlineValue !== undefined
        ? inlineValue
        : next === "true" || next === "false"
          ? next
          : undefined;
      if (inlineValue === undefined && explicitValue !== undefined) index += 1;
      if (explicitValue === undefined) {
        if (next && !next.startsWith("--")) {
          throw Object.assign(new Error(`布尔选项 --${rawKey} 只接受 true 或 false`), { code: "INVALID_BOOLEAN" });
        }
        options[key] = true;
      } else if (explicitValue === "true") options[key] = true;
      else if (explicitValue === "false") options[key] = false;
      else throw Object.assign(new Error(`布尔选项 --${rawKey} 只接受 true 或 false`), { code: "INVALID_BOOLEAN" });
    } else if (inlineValue !== undefined) options[key] = inlineValue;
    else if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { command, options };
}

function enabled(value) {
  return value === true;
}

function list(value) {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    process.stdout.write(usage());
    return;
  }
  const projectRoot = resolve(options.projectRoot || defaultProjectRoot);
  const engineOptions = { projectRoot };
  const registryPath = options.registry || process.env.HUANGQUE_REGISTRY_PATH;
  const artifactRoot = options.artifactRoot || process.env.HUANGQUE_ARTIFACT_ROOT;
  if (registryPath) engineOptions.registryPath = resolve(registryPath);
  if (artifactRoot) engineOptions.artifactRoot = resolve(artifactRoot);
  if (process.env.HUANGQUE_EMPLOYER_UNIVERSE_PATH) engineOptions.employerUniversePath = resolve(process.env.HUANGQUE_EMPLOYER_UNIVERSE_PATH);
  if (process.env.HUANGQUE_SOURCE_SPIDER_STATE_PATH) engineOptions.sourceSpiderStatePath = resolve(process.env.HUANGQUE_SOURCE_SPIDER_STATE_PATH);
  const engine = new HuangqueEngine(engineOptions);
  let output;
  if (command === "init") output = await engine.bootstrapExistingSources();
  else if (command === "status") output = await engine.status();
  else if (command === "coverage") output = await engine.sourceCoverage();
  else if (command === "discover") {
    const importedInput = options.input ? JSON.parse(await readFile(resolve(options.input), "utf8")) : null;
    output = await engine.discoverSources({
      providers: list(options.providers),
      bucketIds: list(options.buckets),
      maxQueries: Number(options.maxQueries || 40),
      importedInput,
      force: enabled(options.force),
      provinceCode: options.provinceCode,
      cityCode: options.cityCode,
    });
  } else if (command === "submit") output = await engine.submitSource({ url: options.url, title: options.title, note: options.note });
  else if (command === "probe") output = await engine.probeSource({ sourceId: options.source, url: options.url });
  else if (command === "sources") output = await engine.listSources({ lifecycle: options.lifecycle, verificationState: options.verificationState, provinceCode: options.provinceCode, cityCode: options.cityCode, limit: Number(options.limit || 100), cursor: Number(options.cursor || 0) });
  else if (command === "review") output = await engine.reviewSource({
    sourceId: options.source,
    decision: options.decision,
    reason: options.reason,
    reviewedBy: options.reviewer,
    expectedRevision: Number(options.revision),
    confirmation: enabled(options.confirm),
  });
  else if (command === "collect") output = await engine.collectJobs({ sourceId: options.source || null, commit: enabled(options.commit) });
  else if (command === "pipeline") output = await engine.runPipeline({
    providers: list(options.providers),
    bucketIds: list(options.buckets),
    maxQueries: Number(options.maxQueries || 20),
    maxProbes: Number(options.maxProbes || 10),
    collectApproved: enabled(options.collectApproved),
    commit: enabled(options.commit),
    force: enabled(options.force),
    provinceCode: options.provinceCode,
    cityCode: options.cityCode,
  });
  else if (command === "source-spider") output = await engine.runSourceSpider({
    maxEmployers: Number(options.maxEmployers || 100),
    maxProbes: Number(options.maxProbes || 20),
    maxCrawlPages: Number(options.maxCrawlPages || 20),
    deep: enabled(options.deep),
  });
  else if (command === "job-update") output = await engine.runJobUpdate({ commitApproved: enabled(options.commit), maxCollections: Number(options.maxCollections || 100) });
  else if (command === "run-due") output = await engine.runDue({ commitApproved: enabled(options.commit), maxCollections: Number(options.maxCollections || 20) });
  else if (command === "jobs") output = await engine.listJobs({ status: options.status || "confirmed_active", provinceCode: options.provinceCode, cityCode: options.cityCode, limit: Number(options.limit || 100), cursor: Number(options.cursor || 0) });
  else if (command === "regions") output = await engine.listRegions({ provinceCode: options.provinceCode });
  else if (command === "graph") output = await engine.getSourceGraph({ sourceId: options.source, relationType: options.relationType, limit: Number(options.limit || 200), cursor: Number(options.cursor || 0) });
  else if (command === "get-run") output = await engine.getRun(options.run);
  else if (command === "export-hosted") output = await engine.exportHostedProjection({ outputPath: options.output ? resolve(options.output) : undefined });
  else if (command === "audit") output = await engine.audit({ outputPath: options.output ? resolve(options.output) : null });
  else throw Object.assign(new Error(`未知命令：${command}`), { code: "UNKNOWN_COMMAND" });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const executionTool = executionToolByCommand.get(command);
  if (executionTool && huangqueToolResultOutcome(executionTool, output).isError) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`黄雀失败 [${error.code || "ERROR"}]：${error.message}\n`);
  process.exitCode = 1;
});
