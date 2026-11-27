import { prisma } from "../../../lib/database.js";
import { transaction } from "../../../shared/transaction.js";
import type { NorthPanelDocument } from "../content-schema.js";
import { effectiveQuery, facetQuery, outputKeys, referenced } from "./binding-queries.js";
import { allowedBindingFilterSchema, datasetQuerySchema, type DatasetQuery } from "./query-contract.js";
import { executeDatasetQuery, gated, readTransaction } from "./query-service.js";

/** Leaves room in the query cache for what readers ask with their own filters. */
export const WARMUP_MAX_QUERIES = 300;
const FIRST_SWEEP_MS = 15_000;
const SWEEP_EVERY_MS = 5 * 60_000;

type Job = { organizationId: string; datasetId: string; query: DatasetQuery };

/**
 * The queries a published view runs before anyone touches a filter, built with the same functions the endpoints use so
 * the cache keys are identical: each widget's data, a table in its default order, and the filter options.
 * Results of every view come first, filter options after them.
 */
async function openingQueries(): Promise<Job[]> {
  const panels = await prisma.northPanel.findMany({
    where: { status: "PUBLISHED", resourceKind: "CONTENT", publishedRevisionId: { not: null }, organization: { status: "ACTIVE" } },
    select: { id: true, organizationId: true, publishedRevision: { select: { document: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const results: Job[] = [];
  const options: Job[] = [];
  for (const panel of panels) {
    const document = panel.publishedRevision!.document as unknown as NorthPanelDocument;
    const bindings = (await prisma.northAnalyticsBinding.findMany({ where: { panelId: panel.id, organizationId: panel.organizationId } }))
      .filter((binding) => referenced(document, binding));
    if (!bindings.length) continue;
    const dateFields = new Map((await prisma.northDatasetField.findMany({
      where: { organizationId: panel.organizationId, datasetId: { in: [...new Set(bindings.map((binding) => binding.datasetId))] } },
      select: { id: true, canonicalType: true },
    })).map((field) => [field.id, field.canonicalType]));
    const components = document.sections.flatMap((section) => section.components);
    for (const binding of bindings) {
      const parsed = datasetQuerySchema.safeParse(binding.query);
      const allowed = allowedBindingFilterSchema.array().safeParse(binding.allowedFilters);
      if (!parsed.success || !allowed.success) continue;
      const query = parsed.data;
      const job = (q: DatasetQuery): Job => ({ organizationId: panel.organizationId, datasetId: binding.datasetId, query: q });
      // A table asks for its default order; every other widget asks for the query as declared.
      const sorts = components.filter((component) => component.type === "data_grid" && component.bindings.data?.sourceId === binding.id)
        .map((component) => (component.props as { defaultSort?: { key?: unknown; direction?: unknown } }).defaultSort);
      for (const sort of sorts.length ? sorts : [undefined]) {
        const usable = sort && typeof sort.key === "string" && outputKeys(query).includes(sort.key) && (sort.direction === "ASC" || sort.direction === "DESC");
        results.push(job(effectiveQuery(query, [], usable ? { sort: { key: sort.key as string, direction: sort.direction as "ASC" | "DESC" } } : {})));
      }
      for (const policy of allowed.data) {
        const type = dateFields.get(policy.fieldId);
        const picks = policy.operators.includes("IN") || policy.operators.includes("EQ");
        if (type === "DATE" || type === "DATETIME") for (const granularity of ["MONTH", "YEAR"] as const) options.push(job(facetQuery(query, policy.fieldId, [], { limit: 100, granularity })));
        else if (type && type !== "DECIMAL" && picks) options.push(job(facetQuery(query, policy.fieldId, [], { limit: 50 })));
      }
    }
  }
  const unique = new Map([...results, ...options].map((job) => [`${job.organizationId}|${job.datasetId}|${JSON.stringify(job.query)}`, job]));
  return [...unique.values()].slice(0, WARMUP_MAX_QUERIES);
}

/**
 * Computes the opening queries into the query cache, one at a time so readers keep the other slots. What is already
 * cached costs one lookup, so repeating the sweep picks up new imports, edits and evictions. Nothing is returned to
 * anyone: readers are still authorized on every request before the cache is looked at.
 */
export async function warmPublishedViews(signal?: AbortSignal) {
  const jobs = await openingQueries();
  let failed = 0;
  for (const job of jobs) {
    if (signal?.aborted) break;
    try {
      await gated(() => transaction((tx) => executeDatasetQuery(tx, job.organizationId, job.datasetId, job.query), readTransaction), { ...(signal ? { signal } : {}) });
    } catch { failed += 1; }
  }
  return { queries: jobs.length, failed };
}

/** First sweep shortly after boot, then periodically. Disabled with NORTH_VIEW_WARMUP_ENABLED=false. */
export function startViewWarmup(onError: (error: unknown) => void, onFailures: (summary: { queries: number; failed: number }) => void) {
  if (process.env.NORTH_VIEW_WARMUP_ENABLED === "false") return () => undefined;
  const stopped = new AbortController();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await warmPublishedViews(stopped.signal);
      if (summary.failed) onFailures(summary);
    } catch (error) { onError(error); } finally { running = false; }
  };
  const first = setTimeout(tick, FIRST_SWEEP_MS);
  const timer = setInterval(tick, SWEEP_EVERY_MS);
  return () => { stopped.abort(); clearTimeout(first); clearInterval(timer); };
}
