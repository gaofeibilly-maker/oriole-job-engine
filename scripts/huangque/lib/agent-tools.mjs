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
    title: "运行黄雀流水线",
    description: "执行发现→安全探测→候选入来源图谱；新来源不会自动批准。可选采集已批准来源。",
    inputSchema: schema({
      providers: { type: "array", items: { enum: ["official_catalog", "common_crawl", "baidu"] }, description: "发现 Provider；默认全部" },
      bucket_ids: { type: "array", items: { type: "string" } },
      max_queries: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      max_probes: { type: "integer", minimum: 0, maximum: 30, default: 10 },
      collect_approved: { type: "boolean", default: false },
      commit: { type: "boolean", default: false, description: "仅影响已批准来源；默认预览" },
      force: { type: "boolean", default: false },
      province_code: { type: "string", description: "可选六位省级行政区代码 / optional province code" },
      city_code: { type: "string", description: "可选六位地级行政区代码 / optional prefecture code" },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行黄雀流水线", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.get_run",
    title: "查看运行",
    description: "按 run_id 读取黄雀运行状态、统计、证据索引和错误。",
    inputSchema: schema({ run_id: { type: "string", minLength: 1 } }, ["run_id"]),
    outputSchema: objectOutput,
    annotations: { title: "查看运行", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.status",
    title: "查看黄雀状态",
    description: "读取 Registry 版本、来源/岗位/运行统计、到期查询桶和 Provider 配置状态。",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "查看黄雀状态", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.source_coverage",
    title: "检查来源覆盖缺口 / Inspect source coverage gaps",
    description: "按 9 类渠道、19 家有界重点企业、34 个省级与 365 个二级区域计算可审计缺口；不把发现线索冒充已批准来源，也不声称抓全互联网。",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "检查来源覆盖缺口", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.discover_sources",
    title: "发现招聘信息源",
    description: "按查询计划通过官方目录、Common Crawl 和已配置的百度官方 API 发现候选；只写候选和证据。",
    inputSchema: schema({
      providers: { type: "array", items: { enum: ["official_catalog", "common_crawl", "baidu"] } },
      bucket_ids: { type: "array", items: { type: "string" } },
      max_queries: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      force: { type: "boolean", default: false },
      province_code: { type: "string" },
      city_code: { type: "string" },
    }),
    outputSchema: objectOutput,
    annotations: { title: "发现招聘信息源", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    annotations: { title: "提交公开来源", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.probe_source",
    title: "安全探测来源",
    description: "对 source_id 或公开 URL 执行 DNS/重定向/robots/大小/超时防护下的真实探测；不会自动批准。",
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
    annotations: { title: "安全探测来源", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.list_sources",
    title: "查询来源图谱",
    description: "查询持久化来源 Registry；可按生命周期或验证状态过滤。",
    inputSchema: schema({
      lifecycle: { enum: ["candidate", "probed", "approved", "rejected"] },
      verification_state: { type: "string" },
      province_code: { type: "string" },
      city_code: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      cursor: { type: "integer", minimum: 0, default: 0 },
    }),
    outputSchema: objectOutput,
    annotations: { title: "查询来源图谱", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.list_jobs",
    title: "查询岗位库",
    description: "分页读取已由批准来源采集的全国标准化岗位，可按省、市筛选。 Lists normalized China jobs with province/prefecture filters.",
    inputSchema: schema({
      status: { enum: ["confirmed_active", "needs_review", "closed"] },
      province_code: { type: "string" },
      city_code: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      cursor: { type: "integer", minimum: 0, default: 0 },
    }),
    outputSchema: objectOutput,
    annotations: { title: "查询岗位库", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.list_regions",
    title: "查询全国地区 / List China regions",
    description: "读取黄雀使用的省级—地级二级地区目录和岗位计数。 Returns the deterministic province/prefecture taxonomy and job counts.",
    inputSchema: schema({ province_code: { type: "string" } }),
    outputSchema: objectOutput,
    annotations: { title: "查询全国地区", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    annotations: { title: "读取招聘源图谱", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.review_source",
    title: "人工审核来源",
    description: "批准或驳回已探测来源。要求人工确认、审核人、理由和 expected_revision；MCP 端默认禁用，需 operator 显式授权。",
    inputSchema: schema({
      source_id: { type: "string", minLength: 1 },
      decision: { enum: ["approve", "reject"] },
      reason: { type: "string", minLength: 4 },
      reviewed_by: { type: "string", minLength: 2 },
      expected_revision: { type: "integer", minimum: 1 },
      confirmation: { const: true },
    }, ["source_id", "decision", "reason", "reviewed_by", "expected_revision", "confirmation"]),
    outputSchema: objectOutput,
    annotations: { title: "人工审核来源", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "huangque.collect_jobs",
    title: "采集已批准来源",
    description: "仅从 approved 来源采集、标准化、强键去重和更新时效；commit 默认 false，预览不写岗位库。",
    inputSchema: schema({
      source_id: { type: "string", minLength: 1 },
      commit: { type: "boolean", default: false },
    }),
    outputSchema: objectOutput,
    annotations: { title: "采集已批准来源", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.run_due",
    title: "运行到期任务",
    description: "按 cadence 运行到期发现、探测与已批准来源采集；commit 默认 false，只有显式 true 才写岗位库。",
    inputSchema: schema({
      max_queries: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      max_probes: { type: "integer", minimum: 0, maximum: 30, default: 10 },
      max_collections: { type: "integer", minimum: 0, maximum: 100, default: 20 },
      commit: { type: "boolean", default: false },
    }),
    outputSchema: objectOutput,
    annotations: { title: "运行到期任务", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "huangque.audit",
    title: "运行黄雀自审",
    description: "运行不变量与外部激活项检查；不会把报告写入任意路径。",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "运行黄雀自审", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "huangque.export_hosted_projection",
    title: "导出托管投影",
    description: "把完整 portable Registry 确定性压缩为外部托管系统可同步的有界投影，并返回文件路径与截断清单。",
    inputSchema: schema(),
    outputSchema: objectOutput,
    annotations: { title: "导出托管投影", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      maxQueries: integer(args.max_queries, 20),
      maxProbes: integer(args.max_probes, 10),
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
      maxQueries: integer(args.max_queries, 40),
      force: Boolean(args.force),
      provinceCode: args.province_code,
      cityCode: args.city_code,
    });
    return { runId: output.runId, tasks: output.tasks, providerRuns: output.input.metadata.providerRuns, discovery: output.discovery };
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
    status: args.status,
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
    maxQueries: integer(args.max_queries, 20),
    maxProbes: integer(args.max_probes, 10),
    maxCollections: integer(args.max_collections, 20),
  });
  if (name === "huangque.audit") return engine.audit();
  if (name === "huangque.export_hosted_projection") return engine.exportHostedProjection();
  throw Object.assign(new Error(`未知工具：${name}`), { code: "UNKNOWN_TOOL" });
}
