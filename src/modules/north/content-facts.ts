import type { Transaction } from "../../shared/transaction.js";
import { authorizeDataset } from "./data/authorization.js";
import type { BindingFacts, DatasetFacts } from "./content-validation.js";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Tenant-scoped facts the report needs: the panel's own bindings and the datasets behind them, with access resolved
 *  for the acting user through the same dataset authorization the results endpoint uses. */
export async function gatherDraftFacts(tx: Transaction, userId: string, organizationId: string, panelId: string, document: unknown) {
  const bindingIds = new Set<string>();
  for (const section of list(isRecord(document) ? document.sections : []))
    for (const component of list(isRecord(section) ? section.components : []))
      for (const reference of Object.values(isRecord(component) && isRecord(component.bindings) ? component.bindings : {}))
        if (isRecord(reference) && reference.sourceType === "dataset" && typeof reference.sourceId === "string") bindingIds.add(reference.sourceId);
  const bindingRows = bindingIds.size
    ? await tx.northAnalyticsBinding.findMany({ where: { organizationId, panelId, id: { in: [...bindingIds] } } })
    : [];
  const bindings = new Map<string, BindingFacts>(bindingRows.map((row) => [row.id, { id: row.id, datasetId: row.datasetId, query: row.query as unknown }]));
  const datasetIds = [...new Set(bindingRows.map((row) => row.datasetId))];
  const datasetRows = datasetIds.length
    ? await tx.northDataset.findMany({ where: { organizationId, id: { in: datasetIds } }, select: { id: true, status: true, activeRevisionId: true } })
    : [];
  const datasets = new Map<string, DatasetFacts>();
  for (const row of datasetRows) {
    const available = row.status === "ACTIVE" && Boolean(row.activeRevisionId);
    let accessible = false;
    if (available) {
      try { await authorizeDataset(tx, userId, organizationId, row.id, "north.data.query"); accessible = true; } catch { accessible = false; }
    }
    datasets.set(row.id, { id: row.id, available, accessible });
  }
  return { bindings, datasets };
}
