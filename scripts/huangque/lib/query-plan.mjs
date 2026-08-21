function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function expandTemplate(template, dimensions = {}) {
  const placeholders = [...String(template).matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((match) => match[1]);
  if (placeholders.length === 0) return [template];
  let values = [{ text: template, dimensionValues: {} }];
  for (const placeholder of [...new Set(placeholders)]) {
    let choices = Array.isArray(dimensions[placeholder]) ? dimensions[placeholder] : [];
    if (choices.includes("$all_prefecture_level")) {
      choices = [...new Set([
        ...choices.filter((choice) => choice !== "$all_prefecture_level"),
        ...listChinaRegions().flatMap((province) => province.cities.map((city) => city.cityName)),
      ])];
    }
    if (choices.length === 0) throw new TypeError(`查询模板缺少维度：${placeholder}`);
    values = values.flatMap((current) => choices.map((choice) => ({
      text: current.text.replaceAll(`{${placeholder}}`, choice),
      dimensionValues: { ...current.dimensionValues, [placeholder]: choice },
    })));
  }
  return values;
}

function normalizedProviders(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((provider) => String(provider || "").trim()).filter(Boolean))];
}

export function queryTaskProviders(query, declaredProviders = null) {
  const declared = normalizedProviders(declaredProviders);
  if (declared?.length) return declared;
  // Common Crawl is a URL index, so it is only eligible for controlled site: tasks.
  // Broad keyword discovery requires Baidu's official Search API.
  return /(?:^|\s)site:[^\s"']+/i.test(String(query || ""))
    ? ["baidu", "common_crawl"]
    : ["baidu"];
}

export function queryTaskHasAvailableProvider(task, availableProviders) {
  if (availableProviders === null || availableProviders === undefined) return true;
  const available = new Set(availableProviders);
  return (task.providers || queryTaskProviders(task.query)).some((provider) => available.has(provider));
}

export function expandQueryPlan(plan) {
  if (plan?.schemaVersion !== "huangque.query-plan.v1" || !Array.isArray(plan.buckets)) {
    throw new TypeError("查询计划必须符合 huangque.query-plan.v1");
  }
  const tasks = [];
  for (const bucket of plan.buckets) {
    if (!bucket?.id || !Number.isFinite(Number(bucket.cadenceDays))) throw new TypeError("每个查询桶必须包含 id 与 cadenceDays");
    const raw = [
      ...(bucket.queries || []).map((query) => ({ text: query, dimensionValues: {} })),
      ...(bucket.seedQueries || []).map((query) => ({ text: query, dimensionValues: {}, seed: true })),
      ...(bucket.templates || []).flatMap((template) => expandTemplate(template, bucket.dimensions)),
    ];
    for (const [index, query] of raw.entries()) {
      tasks.push({
        id: `${bucket.id}:${String(index + 1).padStart(3, "0")}`,
        bucketId: bucket.id,
        bucketLabel: bucket.label || bucket.id,
        cadenceDays: Number(bucket.cadenceDays),
        query: query.text,
        dimensions: query.dimensionValues,
        seed: Boolean(query.seed),
        providers: queryTaskProviders(query.text, bucket.providers),
      });
    }
  }
  return tasks;
}

export function dueQueryBuckets(plan, bucketState = {}, now = new Date()) {
  const effectiveNow = parseDate(now) || new Date();
  const tasks = expandQueryPlan(plan);
  const grouped = new Map();
  for (const task of tasks) {
    const group = grouped.get(task.bucketId) || { ...task, tasks: [] };
    group.tasks.push(task);
    grouped.set(task.bucketId, group);
  }
  return [...grouped.values()].map((group) => {
    const state = bucketState[group.bucketId] || {};
    const lastCompletedAt = parseDate(state.lastCompletedAt);
    const validTaskIds = new Set(group.tasks.map((task) => task.id));
    const completedTaskIds = [...new Set(Array.isArray(state.completedTaskIds) ? state.completedTaskIds : [])]
      .filter((taskId) => validTaskIds.has(taskId));
    const completed = new Set(completedTaskIds);
    const dueAt = lastCompletedAt
      ? new Date(lastCompletedAt.getTime() + group.cadenceDays * 86_400_000)
      : null;
    const due = completedTaskIds.length > 0 || !dueAt || dueAt <= effectiveNow;
    return {
      id: group.bucketId,
      label: group.bucketLabel,
      cadenceDays: group.cadenceDays,
      lastCompletedAt: lastCompletedAt?.toISOString() || null,
      dueAt: dueAt?.toISOString() || null,
      due,
      completedTaskIds,
      completedTasks: completedTaskIds.length,
      totalTasks: group.tasks.length,
      tasks: due ? group.tasks.filter((task) => !completed.has(task.id)) : group.tasks,
    };
  });
}

export function selectDueQueryTasks(plan, bucketState = {}, {
  now = new Date(),
  bucketIds = null,
  maxQueries = Infinity,
  availableProviders = null,
} = {}) {
  const selectedBuckets = new Set(bucketIds || []);
  const buckets = dueQueryBuckets(plan, bucketState, now)
    .filter((bucket) => (selectedBuckets.size ? selectedBuckets.has(bucket.id) : bucket.due))
    .map((bucket) => ({
      ...bucket,
      queue: bucket.tasks.filter((task) => queryTaskHasAvailableProvider(task, availableProviders)),
    }));
  const limit = Math.max(0, Number(maxQueries) || 0);
  const selected = [];
  // Round-robin prevents a large bucket from starving every bucket behind it.
  while (selected.length < limit && buckets.some((bucket) => bucket.queue.length > 0)) {
    for (const bucket of buckets) {
      const task = bucket.queue.shift();
      if (task) selected.push(task);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}
import { listChinaRegions } from "./china-regions.mjs";
