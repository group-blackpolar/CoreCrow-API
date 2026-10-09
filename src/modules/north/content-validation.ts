// Pre-publish validation of a panel draft ("View Health"). It never mutates anything: it reads the draft, the panel's
// analytics bindings and the datasets they point at, and reports what would be wrong or silently degrade once
// published. `buildDraftReport` is pure (unit-tested without a database); the database-bound inputs are gathered by
// `gatherDraftFacts` in content-facts.ts.

export type DraftIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  sectionId?: string;
  componentId?: string;
};
export type DraftDependency = {
  kind: "binding" | "dataset";
  id: string;
  status: "ok" | "missing" | "unavailable" | "forbidden";
  componentIds: string[];
};
export type DraftReport = { valid: boolean; issues: DraftIssue[]; dependencies: DraftDependency[] };

type Json = Record<string, unknown>;
export type BindingFacts = { id: string; datasetId: string; query: unknown };
export type DatasetFacts = { id: string; available: boolean; accessible: boolean };

const CHART_TYPES = new Set(["bar_chart", "line_chart", "donut_chart"]);
// Components that read several named bindings; their mapped keys are checked against the union of those bindings' outputs.
const ANALYTICS_TYPES = new Set(["kpi_card", "data_grid", "geo_map", "insights"]);
const DEVICES = ["desktop", "tablet", "mobile"] as const;

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Output keys of a declared binding query: exactly what the results endpoint returns as columns. */
export function bindingOutputKeys(query: unknown): Set<string> {
  const keys = new Set<string>();
  if (!isRecord(query)) return keys;
  if (query.mode === "ROWS") for (const field of list(query.fields)) if (typeof field === "string") keys.add(field);
  if (query.mode === "AGGREGATE") {
    for (const field of list(query.groupBy)) if (typeof field === "string") keys.add(field);
    for (const measure of list(query.measures)) if (isRecord(measure) && typeof measure.alias === "string") keys.add(measure.alias);
  }
  return keys;
}

function mappedKeys(type: string, props: Json): string[] {
  const keys: string[] = [];
  if (type === "metric" && typeof props.fieldKey === "string") keys.push(props.fieldKey);
  if (type === "kpi_card" && typeof props.valueKey === "string") keys.push(props.valueKey);
  if (type === "geo_map") for (const key of [props.regionKey, props.valueKey, props.secondaryKey]) if (typeof key === "string") keys.push(key);
  if (type === "data_grid") for (const column of list(props.columns)) if (isRecord(column) && typeof column.key === "string" && column.kind !== "sparkline" && column.kind !== "actions") keys.push(column.key);
  if (CHART_TYPES.has(type)) {
    if (typeof props.categoryKey === "string") keys.push(props.categoryKey);
    if (typeof props.valueKey === "string") keys.push(props.valueKey);
    for (const item of list(props.series)) if (isRecord(item) && typeof item.key === "string") keys.push(item.key);
  }
  return keys;
}

export function buildDraftReport(input: {
  document: unknown;
  schemaError: { code: string; message: string } | null;
  bindings: ReadonlyMap<string, BindingFacts>;
  datasets: ReadonlyMap<string, DatasetFacts>;
}): DraftReport {
  const issues: DraftIssue[] = [];
  const dependencies = new Map<string, DraftDependency>();
  const depend = (kind: DraftDependency["kind"], id: string, status: DraftDependency["status"], componentId: string) => {
    const key = `${kind}:${id}`;
    const entry = dependencies.get(key) ?? { kind, id, status, componentIds: [] };
    if (!entry.componentIds.includes(componentId)) entry.componentIds.push(componentId);
    dependencies.set(key, entry);
  };

  if (input.schemaError) issues.push({ severity: "error", code: input.schemaError.code, message: input.schemaError.message });

  const sections = isRecord(input.document) ? list(input.document.sections) : [];
  let componentCount = 0;
  for (const rawSection of sections) {
    if (!isRecord(rawSection)) continue;
    const sectionId = typeof rawSection.id === "string" ? rawSection.id : undefined;
    const components = list(rawSection.components).filter(isRecord);
    componentCount += components.length;
    for (const component of components) {
      const componentId = typeof component.id === "string" ? component.id : "";
      const type = typeof component.type === "string" ? component.type : "";
      const props = isRecord(component.props) ? component.props : {};
      const references = Object.values(isRecord(component.bindings) ? component.bindings : {}).filter(isRecord)
        .filter((reference) => reference.sourceType === "dataset" && typeof reference.sourceId === "string");
      if (ANALYTICS_TYPES.has(type) && references.length === 0)
        issues.push({ severity: "error", code: "BINDING_REQUIRED", message: "This analytics component needs a data binding to render anything", sectionId, componentId });
      if (CHART_TYPES.has(type) && references.length === 0)
        issues.push({ severity: "error", code: "BINDING_REQUIRED", message: "A chart needs a data binding to render anything", sectionId, componentId });
      if (type === "metric" && typeof props.fieldKey === "string" && references.length === 0)
        issues.push({ severity: "warning", code: "METRIC_FIELD_WITHOUT_BINDING", message: "The metric maps a result field but has no data binding; its static value is shown instead", sectionId, componentId });
      for (const reference of references) {
        const bindingId = String(reference.sourceId);
        const binding = input.bindings.get(bindingId);
        if (!binding || (typeof reference.datasetId === "string" && binding.datasetId !== reference.datasetId)) {
          depend("binding", bindingId, "missing", componentId);
          issues.push({ severity: "error", code: "BINDING_NOT_FOUND", message: "The component references a data binding that does not exist on this view", sectionId, componentId });
          continue;
        }
        depend("binding", bindingId, "ok", componentId);
        const dataset = input.datasets.get(binding.datasetId);
        if (!dataset || !dataset.available) {
          depend("dataset", binding.datasetId, "unavailable", componentId);
          issues.push({ severity: "error", code: "DATASET_UNAVAILABLE", message: "The dataset behind this binding is archived or has no active revision", sectionId, componentId });
          continue;
        }
        if (!dataset.accessible) {
          depend("dataset", binding.datasetId, "forbidden", componentId);
          issues.push({ severity: "error", code: "DATASET_FORBIDDEN", message: "You do not have query access to the dataset behind this binding", sectionId, componentId });
          continue;
        }
        depend("dataset", binding.datasetId, "ok", componentId);
        const available = bindingOutputKeys(binding.query);
        if (ANALYTICS_TYPES.has(type)) continue;
        const stale = mappedKeys(type, props).filter((key) => !available.has(key));
        if (stale.length)
          issues.push({ severity: "error", code: "FIELD_NOT_IN_BINDING", message: `Mapped fields are not returned by the binding: ${stale.slice(0, 5).join(", ")}`, sectionId, componentId });
      }
    }
    for (const component of components) {
      const type = typeof component.type === "string" ? component.type : "";
      if (!ANALYTICS_TYPES.has(type)) continue;
      const props = isRecord(component.props) ? component.props : {};
      const references = Object.values(isRecord(component.bindings) ? component.bindings : {}).filter(isRecord)
        .filter((reference) => reference.sourceType === "dataset" && typeof reference.sourceId === "string");
      const union = new Set<string>();
      let resolved = 0;
      for (const reference of references) {
        const binding = input.bindings.get(String(reference.sourceId));
        if (!binding) continue;
        resolved += 1;
        for (const key of bindingOutputKeys(binding.query)) union.add(key);
      }
      if (!resolved) continue;
      const stale = mappedKeys(type, props).filter((key) => !union.has(key));
      if (stale.length)
        issues.push({ severity: "error", code: "FIELD_NOT_IN_BINDING", message: `Mapped fields are not returned by any binding of this component: ${stale.slice(0, 5).join(", ")}`, sectionId: typeof rawSection.id === "string" ? rawSection.id : undefined, componentId: typeof component.id === "string" ? component.id : "" });
    }
    for (const device of DEVICES) {
      const cells = components.map((component) => ({ id: component.id, cell: isRecord(component.layout) ? component.layout[device] : null }))
        .filter((entry): entry is { id: string; cell: Json } => isRecord(entry.cell));
      overlap: for (let first = 0; first < cells.length; first++) for (let second = first + 1; second < cells.length; second++) {
        const a = cells[first]!.cell; const b = cells[second]!.cell;
        const [ax, ay, aw, ah, bx, by, bw, bh] = [a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h].map(Number);
        if ([ax, ay, aw, ah, bx, by, bw, bh].some((n) => !Number.isFinite(n))) continue;
        if (ax! < bx! + bw! && bx! < ax! + aw! && ay! < by! + bh! && by! < ay! + ah!) {
          issues.push({ severity: "warning", code: "LAYOUT_OVERLAP", message: `Components overlap on the ${device} layout`, sectionId, componentId: String(cells[first]!.id) });
          break overlap;
        }
      }
    }
  }
  if (!input.schemaError && componentCount === 0) issues.push({ severity: "warning", code: "EMPTY_VIEW", message: "The draft has no components" });
  return { valid: !issues.some((issue) => issue.severity === "error"), issues, dependencies: [...dependencies.values()] };
}
