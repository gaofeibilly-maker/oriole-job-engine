const objectOutput = {
  type: "object",
  additionalProperties: true,
};

function schema(properties = {}, required = []) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export const HUANGQUE_TOOLS = [
  {
    name: "huangque.run_pipeline",
    title: "运行黄雀流水线 / Run Oriole pipeline",
    description: "按需执行发现→安全探测→候选入图；新来源不会自动批准。Runs on-demand discovery and safe probing; new sources never receive automatic approval.",
    inputSchema: schema({
      providers: { type: "array", items: { enum: ["official_catalog", "common_crawl", "baidu"] }, description: "发现 Provider；默认全部" },
      bucket_ids: { type: "array", items: { type: "string" } },
      max_queries: { type: "integer", minimum: 1, maximum: 100, default: 3 },
      max_probes: { type: "integer", minimum: 0, maximum: 30, default: 1 },
      collect_approved: { type: "boolean", default: false },
      commit: { type: "boolean", default: false, description: "仅影响已批准来源；默认预览" },
      force: { type: "boolean", default: false },
      province_code: { type: "string", description: "可选六位省级行政区代码 / optional province code" },
      city_code: { type: "string", description: "可选六位地级行政区代码 / optional prefecture code" },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行黄雀流水线 / Run Oriole pipeline", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.get_run",
    title: "查看运行 / Get run",
    description: "按 run_id 读取运行状态、统计、证据和错误。Gets one run's status, statistics, evidence indexes, and errors.",
    inputSchema: schema({ run_id: { type: "string", minLength: 1 } }, ["run_id"]),
    outputSchema: objectOutput,
    annotations: { title: "查看运行 / Get run", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.status",
    title: "查看黄雀状态 / Get Oriole status",
    description: "读取 Registry、5000+ 目标库、来源、岗位、队列和 Provider 状态。Gets Registry, employer-universe, source, job, queue, and provider status.",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "查看黄雀状态 / Get Oriole status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.source_coverage",
    title: "检查来源覆盖缺口 / Inspect source coverage gaps",
    description: "按渠道、5000+ 目标单位及全国二级地区计算可审计缺口。Computes evidence-backed channel, employer, and region gaps without treating discovery clues as approved coverage.",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "检查来源覆盖缺口", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.discover_sources",
    title: "发现招聘信息源 / Discover sources",
    description: "通过官方目录、Common Crawl 和百度官方 API 发现候选，只写线索与证据。Discovers candidates through public providers and never auto-approves them.",
    inputSchema: schema({
      providers: { type: "array", items: { enum: ["official_catalog", "common_crawl", "baidu"] } },
      bucket_ids: { type: "array", items: { type: "string" } },
      max_queries: { type: "integer", minimum: 1, maximum: 100, default: 3 },
      force: { type: "boolean", default: false },
      province_code: { type: "string" },
      city_code: { type: "string" },
    }),
    outputSchema: objectOutput,
    annotations: { title: "发现招聘信息源 / Discover sources", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.submit_source",
    title: "提交公开来源 / Submit public source",
    description: "把一个公开招聘 URL 作为候选写入图谱并保留提交证据；不会自动探测、批准或采集。 Adds a public URL as an evidence-backed candidate without automatic approval.",
    inputSchema: schema({
      url: { type: "string", format: "uri" },
      title: { type: "string", minLength: 1 },
      note: { type: "string" },
    }, ["url"]),
    outputSchema: objectOutput,
    annotations: { title: "提交公开来源 / Submit public source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.probe_source",
    title: "安全探测来源 / Probe source safely",
    description: "在 DNS、重定向、robots、大小和超时边界内真实探测，不会自动批准。Safely probes a public source under strict network and review boundaries.",
    inputSchema: {
      ...schema({
        source_id: { type: "string", minLength: 1 },
        url: { type: "string", format: "uri" },
      }),
      anyOf: [
        { type: "object", required: ["source_id"] },
        { type: "object", required: ["url"] },
      ],
    },
    outputSchema: objectOutput,
    annotations: { title: "安全探测来源 / Probe source safely", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.list_sources",
    title: "查询来源图谱 / List sources",
    description: "查询持久化来源 Registry，可按生命周期或验证状态过滤。Lists persisted source records with lifecycle and verification filters.",
    inputSchema: schema({
      lifecycle: { enum: ["candidate", "probed", "approved", "rejected"] },
      verification_state: { type: "string" },
      province_code: { type: "string" },
      city_code: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      cursor: { type: "integer", minimum: 0, default: 0 },
    }),
    outputSchema: objectOutput,
    annotations: { title: "查询来源图谱 / List sources", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.list_jobs",
    title: "查询岗位库 / List jobs",
    description: "分页读取已批准来源的全国标准化岗位；默认只返回 confirmed_active。Lists normalized China jobs and defaults to confirmed active records.",
    inputSchema: schema({
      status: { enum: ["confirmed_active", "needs_review", "closed"] },
      province_code: { type: "string" },
      city_code: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      cursor: { type: "integer", minimum: 0, default: 0 },
    }),
    outputSchema: objectOutput,
    annotations: { title: "查询岗位库 / List jobs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.list_regions",
    title: "查询全国地区 / List China regions",
    description: "读取黄雀使用的省级—地级二级地区目录和岗位计数。 Returns the deterministic province/prefecture taxonomy and job counts.",
    inputSchema: schema({ province_code: { type: "string" } }),
    outputSchema: objectOutput,
    annotations: { title: "查询全国地区 / List China regions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.get_source_graph",
    title: "读取招聘源图谱 / Read source graph",
    description: "分页读取发布主体、来源、地区、入口、端点、发现渠道与岗位之间的有证据关系。 Reads evidence-bearing source graph relations.",
    inputSchema: schema({
      source_id: { type: "string" },
      relation_type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      cursor: { type: "integer", minimum: 0, default: 0 },
    }),
    outputSchema: objectOutput,
    annotations: { title: "读取招聘源图谱 / Read source graph", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.review_source",
    title: "人工审核来源 / Review source",
    description: "批准或驳回已探测来源；要求确认、审核人、理由和版本，MCP 默认禁用。Approves or rejects a probed source under explicit operator authorization.",
    inputSchema: schema({
      source_id: { type: "string", minLength: 1 },
      decision: { enum: ["approve", "reject"] },
      reason: { type: "string", minLength: 4 },
      reviewed_by: { type: "string", minLength: 2 },
      expected_revision: { type: "integer", minimum: 1 },
      confirmation: { const: true },
    }, ["source_id", "decision", "reason", "reviewed_by", "expected_revision", "confirmation"]),
    outputSchema: objectOutput,
    annotations: { title: "人工审核来源 / Review source", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "huangque.collect_jobs",
    title: "采集已批准来源 / Collect approved source",
    description: "仅采集 approved 来源；commit 默认 false。Collects, normalizes, deduplicates, and refreshes approved sources only.",
    inputSchema: schema({
      source_id: { type: "string", minLength: 1 },
      commit: { type: "boolean", default: false },
    }, ["source_id"]),
    outputSchema: objectOutput,
    annotations: { title: "采集已批准来源 / Collect approved source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.run_due",
    title: "运行到期岗位更新 / Run due job update",
    description: "兼容入口：只更新到期的 approved 来源，不再混入寻源；commit 默认 false。Compatibility entry that only updates due approved sources.",
    inputSchema: schema({
      max_collections: { type: "integer", minimum: 0, maximum: 100, default: 1 },
      commit: { type: "boolean", default: false },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行到期岗位更新 / Run due job update", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.run_source_spider",
    title: "运行寻源蜘蛛 / Run source spider",
    description: "按 5000+ 目标库、优先级和持久退避发现招聘入口；只产生 candidate/probed。Discovers employer career sources with a persistent bounded queue and never auto-approves them.",
    inputSchema: schema({
      max_employers: { type: "integer", minimum: 1, maximum: 300, default: 1 },
      max_probes: { type: "integer", minimum: 0, maximum: 50, default: 0 },
      max_crawl_pages: { type: "integer", minimum: 0, maximum: 100, default: 1 },
      deep: { type: "boolean", default: false },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行寻源蜘蛛 / Run source spider", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.run_job_update",
    title: "运行岗位更新 / Run job update",
    description: "独立更新到期的 approved 来源，不执行来源发现或探测。Independently refreshes due approved job sources without source discovery.",
    inputSchema: schema({
      max_collections: { type: "integer", minimum: 0, maximum: 100, default: 1 },
      commit: { type: "boolean", default: false },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行岗位更新 / Run job update", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.audit",
    title: "运行黄雀自审 / Audit Oriole",
    description: "检查实现、运行证据、目标库、队列、来源与岗位不变量。Audits implementation and operational evidence without writing arbitrary paths.",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "运行黄雀自审 / Audit Oriole", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.export_hosted_projection",
    title: "导出托管投影 / Export hosted projection",
    description: "生成明确标注截断边界的托管投影；完整数据仍在 Registry。Exports a bounded hosted projection with an explicit truncation manifest.",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "导出托管投影 / Export hosted projection", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function integer(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function collectionSummary(output) {
  if (!output) return null;
  return {
    runId: output.runId,
    commit: output.commit,
    stats: output.stats,
    errors: output.errors,
    results: (output.results || []).map((result) => ({
      sourceId: result.sourceId,
      sourceRevision: result.sourceRevision,
      endpoint: result.endpoint,
      fetchedAt: result.fetchedAt,
      http: result.http,
      artifacts: result.artifacts,
      pagination: result.pagination,
      parser: result.parser,
      parserStats: result.parserStats,
      dedupe: result.dedupe,
      storage: result.storage,
      jobsAvailableVia: "huangque.list_jobs",
    })),
  };
}

const STATUS_RESULT_TOOLS = new Set([
  "huangque.run_pipeline",
  "huangque.discover_sources",
  "huangque.run_due",
  "huangque.run_source_spider",
  "huangque.run_job_update",
]);

const SUCCESSFUL_EXECUTION_STATUSES = new Set([
  "completed",
  "completed_with_findings",
  "no_work",
]);

const unknownOutcome = () => ({ completed: false, isError: true, status: "unknown" });

function collectionOutcome(collection) {
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return unknownOutcome();
  if (!collection.stats || typeof collection.stats !== "object" || Array.isArray(collection.stats)) return unknownOutcome();
  for (const field of ["sourcesRequested", "sourcesSucceeded", "sourcesFailed", "sourcesIncomplete"]) {
    if (collection.stats[field] !== undefined
      && (!Number.isInteger(collection.stats[field]) || collection.stats[field] < 0)) return unknownOutcome();
  }
  if (collection.errors !== undefined && !Array.isArray(collection.errors)) return unknownOutcome();
  const failed = Math.max(Number(collection.stats?.sourcesFailed || 0), Array.isArray(collection.errors) ? collection.errors.length : 0);
  const incomplete = Number(collection.stats?.sourcesIncomplete || 0);
  const succeeded = Number(collection.stats?.sourcesSucceeded || 0);
  const requested = collection.stats.sourcesRequested;
  if (Number.isInteger(requested) && succeeded + failed > requested) return unknownOutcome();
  if (failed > 0) return { completed: false, isError: true, status: succeeded > 0 ? "partial" : "failed" };
  if (incomplete > 0) return { completed: false, isError: true, status: "partial" };
  if (!Number.isInteger(requested)) return unknownOutcome();
  if (requested === 0 && succeeded === 0) return { completed: true, isError: false, status: "no_work" };
  if (succeeded !== requested) return { completed: false, isError: true, status: "partial" };
  return { completed: true, isError: false, status: "completed" };
}

export function huangqueToolResultOutcome(name, result) {
  if (STATUS_RESULT_TOOLS.has(name)) {
    const status = typeof result?.status === "string" ? result.status : "unknown";
    const completed = SUCCESSFUL_EXECUTION_STATUSES.has(status);
    return { completed, isError: !completed, status };
  }
  if (name === "huangque.collect_jobs") return collectionOutcome(result);
  return { completed: true, isError: false, status: null };
}

function assertObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("arguments 必须是对象"), { code: "INVALID_ARGUMENTS" });
  return value;
}

function schemaIssues(schema_, value, path = "arguments") {
  const issues = [];
  if (schema_.anyOf && !schema_.anyOf.some((candidate) => schemaIssues(candidate, value, path).length === 0)) {
    issues.push(`${path} 必须满足至少一个可选输入组合`);
  }
  if (Object.hasOwn(schema_, "const") && value !== schema_.const) issues.push(`${path} 必须等于 ${JSON.stringify(schema_.const)}`);
  if (schema_.enum && !schema_.enum.includes(value)) issues.push(`${path} 必须是 ${schema_.enum.map((item) => JSON.stringify(item)).join(" / ")}`);
  if (schema_.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...issues, `${path} 必须是对象`];
    for (const required of schema_.required || []) {
      if (!Object.hasOwn(value, required)) issues.push(`${path}.${required} 必填`);
    }
    if (schema_.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema_.properties || {}, key)) issues.push(`${path}.${key} 是未知字段`);
    }
    for (const [key, childSchema] of Object.entries(schema_.properties || {})) {
      if (Object.hasOwn(value, key)) issues.push(...schemaIssues(childSchema, value[key], `${path}.${key}`));
    }
  } else if (schema_.type === "array") {
    if (!Array.isArray(value)) return [...issues, `${path} 必须是数组`];
    value.forEach((item, index) => issues.push(...schemaIssues(schema_.items || {}, item, `${path}[${index}]`)));
  } else if (schema_.type === "integer") {
    if (!Number.isInteger(value)) issues.push(`${path} 必须是整数`);
    else {
      if (Number.isFinite(schema_.minimum) && value < schema_.minimum) issues.push(`${path} 不得小于 ${schema_.minimum}`);
      if (Number.isFinite(schema_.maximum) && value > schema_.maximum) issues.push(`${path} 不得大于 ${schema_.maximum}`);
    }
  } else if (schema_.type === "string") {
    if (typeof value !== "string") issues.push(`${path} 必须是字符串`);
    else {
      if (Number.isFinite(schema_.minLength) && value.length < schema_.minLength) issues.push(`${path} 长度不得小于 ${schema_.minLength}`);
      if (schema_.format === "uri") {
        try { new URL(value); } catch { issues.push(`${path} 必须是绝对 URI`); }
      }
    }
  } else if (schema_.type === "boolean" && typeof value !== "boolean") {
    issues.push(`${path} 必须是布尔值`);
  }
  return issues;
}

export function validateToolArguments(tool, arguments_) {
  const issues = schemaIssues(tool.inputSchema, arguments_);
  if (issues.length) {
    throw Object.assign(new Error(`工具参数不符合 inputSchema：${issues.join("；")}`), {
      code: "INVALID_ARGUMENTS",
      issues,
    });
  }
  return arguments_;
}

export async function callHuangqueTool(engine, name, rawArguments, {
  allowMcpReview = process.env.HUANGQUE_ALLOW_MCP_REVIEW === "1",
} = {}) {
  const args = assertObject(rawArguments);
  const tool = HUANGQUE_TOOLS.find((item) => item.name === name);
  if (!tool) throw Object.assign(new Error(`未知工具：${name}`), { code: "UNKNOWN_TOOL" });
  validateToolArguments(tool, args);
  if (name === "huangque.run_pipeline") {
    const output = await engine.runPipeline({
      providers: args.providers,
      bucketIds: args.bucket_ids,
      maxQueries: integer(args.max_queries, 3),
      maxProbes: integer(args.max_probes, 1),
      collectApproved: Boolean(args.collect_approved),
      commit: Boolean(args.commit),
      force: Boolean(args.force),
      provinceCode: args.province_code,
      cityCode: args.city_code,
    });
    return { ...output, collection: collectionSummary(output.collection) };
  }
  if (name === "huangque.get_run") {
    if (!args.run_id) throw Object.assign(new Error("run_id 必填"), { code: "INVALID_ARGUMENTS" });
    return { run: await engine.getRun(args.run_id) };
  }
  if (name === "huangque.status") return engine.status();
  if (name === "huangque.source_coverage") return engine.sourceCoverage();
  if (name === "huangque.discover_sources") {
    const output = await engine.discoverSources({
      providers: args.providers,
      bucketIds: args.bucket_ids,
      maxQueries: integer(args.max_queries, 3),
      force: Boolean(args.force),
      provinceCode: args.province_code,
      cityCode: args.city_code,
    });
    return { runId: output.runId, status: output.status, tasks: output.tasks, providerRuns: output.input.metadata.providerRuns, discovery: output.discovery };
  }
  if (name === "huangque.submit_source") return engine.submitSource({ url: args.url, title: args.title, note: args.note });
  if (name === "huangque.probe_source") {
    if (!args.source_id && !args.url) throw Object.assign(new Error("source_id 或 url 至少提供一个"), { code: "INVALID_ARGUMENTS" });
    return engine.probeSource({ sourceId: args.source_id, url: args.url });
  }
  if (name === "huangque.list_sources") return engine.listSources({
    lifecycle: args.lifecycle,
    verificationState: args.verification_state,
    provinceCode: args.province_code,
    cityCode: args.city_code,
    limit: integer(args.limit, 100),
    cursor: integer(args.cursor, 0),
  });
  if (name === "huangque.list_jobs") return engine.listJobs({
    status: args.status || "confirmed_active",
    provinceCode: args.province_code,
    cityCode: args.city_code,
    limit: integer(args.limit, 100),
    cursor: integer(args.cursor, 0),
  });
  if (name === "huangque.list_regions") return engine.listRegions({ provinceCode: args.province_code });
  if (name === "huangque.get_source_graph") return engine.getSourceGraph({
    sourceId: args.source_id,
    relationType: args.relation_type,
    limit: integer(args.limit, 200),
    cursor: integer(args.cursor, 0),
  });
  if (name === "huangque.review_source") {
    if (!allowMcpReview) throw Object.assign(new Error("MCP 审核写权限默认关闭；由 operator 设置 HUANGQUE_ALLOW_MCP_REVIEW=1 后才可使用"), { code: "OPERATOR_SCOPE_REQUIRED" });
    return { source: await engine.reviewSource({
      sourceId: args.source_id,
      decision: args.decision,
      reason: args.reason,
      reviewedBy: args.reviewed_by,
      expectedRevision: args.expected_revision,
      confirmation: args.confirmation,
    }) };
  }
  if (name === "huangque.collect_jobs") return collectionSummary(await engine.collectJobs({ sourceId: args.source_id, commit: Boolean(args.commit) }));
  if (name === "huangque.run_due") return engine.runDue({
    commitApproved: Boolean(args.commit),
    maxCollections: integer(args.max_collections, 1),
  });
  if (name === "huangque.run_source_spider") return engine.runSourceSpider({
    maxEmployers: integer(args.max_employers, 1),
    maxProbes: integer(args.max_probes, 0),
    maxCrawlPages: integer(args.max_crawl_pages, 1),
    deep: Boolean(args.deep),
  });
  if (name === "huangque.run_job_update") return engine.runJobUpdate({
    commitApproved: Boolean(args.commit),
    maxCollections: integer(args.max_collections, 1),
  });
  if (name === "huangque.audit") return engine.audit();
  if (name === "huangque.export_hosted_projection") return engine.exportHostedProjection();
  throw Object.assign(new Error(`未知工具：${name}`), { code: "UNKNOWN_TOOL" });
}
