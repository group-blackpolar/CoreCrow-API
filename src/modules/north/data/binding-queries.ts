import { fail } from "../../../shared/errors.js";
import type { NorthPanelDocument } from "../content-schema.js";
import type { BindingRuntimeOptions, DatasetQuery, DatasetQueryFilter } from "./query-contract.js";

/* How the endpoints of a published binding turn it into dataset queries. Pure, so that the warm-up builds exactly the same
 * queries (and therefore the same cache keys) as the requests it prepares for. */

export const outputKeys = (query: DatasetQuery) => query.mode === "ROWS" ? query.fields : [...(query.groupBy ?? []), ...query.measures.map((measure) => measure.alias)];

/** The binding's own query narrowed by runtime filters, sort, paging and search. A reader can only shrink the page: the binding's limit is the ceiling. */
export function effectiveQuery(query: DatasetQuery, filters: DatasetQueryFilter[], options: BindingRuntimeOptions): DatasetQuery {
  const effective = { ...query, filters: [...(query.filters ?? []), ...filters] } as DatasetQuery;
  if ((effective.filters?.length ?? 0) > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
  if (options.sort) {
    if (!outputKeys(query).includes(options.sort.key)) fail(422, "BINDING_SORT_NOT_ALLOWED", "Sorting is only available on the binding's own output columns");
    if (effective.mode === "ROWS") effective.orderBy = [{ fieldId: options.sort.key, direction: options.sort.direction }];
    else effective.orderBy = [{ key: options.sort.key, direction: options.sort.direction }];
  }
  if (options.offset !== undefined) effective.offset = options.offset;
  if (options.limit !== undefined) effective.limit = Math.min(options.limit, query.limit ?? 100);
  if (options.search) {
    if (!query.searchFieldIds) fail(422, "BINDING_SEARCH_NOT_ALLOWED", "This binding does not declare searchable fields");
    effective.search = { fieldIds: query.searchFieldIds, text: options.search };
  }
  return effective;
}

export function referenced(document: NorthPanelDocument, binding: { id: string; datasetId: string }) {
  return document.sections.some((section) => section.components.some((component) =>
    Object.values(component.bindings).some((reference) =>
      reference.sourceType === "dataset" && reference.sourceId === binding.id && reference.datasetId === binding.datasetId,
    ),
  ));
}

export type FacetInput = { limit: number; offset?: number; search?: string; granularity?: "DAY" | "MONTH" | "QUARTER" | "YEAR" };

/** The options of one filter field: its values with the number of rows of each, under the binding's own and the other filters. */
export function facetQuery(query: DatasetQuery, fieldId: string, others: DatasetQueryFilter[], input: FacetInput): DatasetQuery {
  const search = input.search?.trim();
  const filters: DatasetQueryFilter[] = [...(query.filters ?? []), ...others, ...(search ? [{ fieldId, operator: "CONTAINS" as const, value: search }] : [])];
  if (filters.length > 10) fail(422, "BINDING_FILTER_LIMIT_EXCEEDED", "Binding filters exceed the maximum of 10");
  // Date buckets (month/year) list the periods that actually hold data, newest first; they ignore text search.
  const bucketed = input.granularity ? { granularity: { [fieldId]: input.granularity } } : {};
  return {
    mode: "AGGREGATE", groupBy: [fieldId], ...bucketed, measures: [{ operation: "COUNT", alias: "count" }],
    filters: input.granularity ? filters.filter((item) => !(item.fieldId === fieldId && item.operator === "CONTAINS")) : filters,
    orderBy: input.granularity ? [{ key: fieldId, direction: "DESC" }] : [{ key: "count", direction: "DESC" }], limit: Math.min(input.limit, 100), offset: input.offset ?? 0, includeTotal: true,
  };
}
