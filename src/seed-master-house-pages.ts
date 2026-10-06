import type { NorthPanelDocument } from "./modules/north/content-schema.js";

/**
 * Declarative Master House report pages for the trusted June demo. Every page is
 * a normal CORECROW panel whose components read authoritative analytics bindings;
 * nothing here executes in the client and no query is composed by NORTH.
 *
 * Aggregate queries are bounded by the platform (two group keys, 100 rows). Looker
 * style page-by-page navigation and the world map are therefore not reproduced:
 * tables show the top rows and charts replace the map.
 */

type Json = Record<string, unknown>;
const localized = (es: string, en: string) => ({ es, en });

export type FilterSpec = { field: string; operators: Array<"EQ" | "NE" | "GT" | "GTE" | "LT" | "LTE" | "CONTAINS"> };
export type BindingSpec = { key: string; name: string; query: (id: (fieldKey: string) => string) => Json };
export type PageSpec = {
  subcategory: { slug: string; name: ReturnType<typeof localized>; order: number };
  panel: { slug: string; name: ReturnType<typeof localized> };
  filters: FilterSpec[];
  bindings: BindingSpec[];
  document: (input: { datasetId: string; id: (fieldKey: string) => string; binding: (key: string) => string }) => NorthPanelDocument;
};

const DATE: FilterSpec = { field: "arrival_date", operators: ["GTE", "LTE"] };
const text = (field: string): FilterSpec => ({ field, operators: ["CONTAINS"] });
const exact = (field: string): FilterSpec => ({ field, operators: ["EQ"] });

type Measure = (id: (key: string) => string) => Json & { alias: string };
const distinctContainers: Measure = (id) => ({ operation: "COUNT_DISTINCT", fieldId: id("container_number"), alias: "containers" });
const sum = (field: string, alias: string): Measure => (id) => ({ operation: "SUM", fieldId: id(field), alias });

function aggregate(input: {
  groupBy?: string[]; measures: Measure[]; orderBy?: Array<{ key: string; direction: "ASC" | "DESC" }>; limit?: number;
}): BindingSpec["query"] {
  return (id) => {
    const measures = input.measures.map((measure) => measure(id));
    const aliases = new Set(measures.map((measure) => measure.alias));
    return {
      mode: "AGGREGATE",
      ...(input.groupBy ? { groupBy: input.groupBy.map(id) } : {}),
      measures,
      // Aggregate ordering references an output: a measure alias or a group field ID.
      ...(input.orderBy ? { orderBy: input.orderBy.map((item) => ({ key: aliases.has(item.key) ? item.key : id(item.key), direction: item.direction })) } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    };
  };
}

/** Lays components on the 12-column grid, stacking the mobile layout in order. */
function grid() {
  let mobileY = 0;
  return (x: number, y: number, w: number, h: number) => {
    const layout = { desktop: { x, y, w, h }, tablet: { x: x >= 6 ? 6 : 0, y, w: 6, h }, mobile: { x: 0, y: mobileY, w: 12, h } };
    mobileY += h;
    return layout;
  };
}

type Place = ReturnType<ReturnType<typeof grid>>;
type Component = NorthPanelDocument["sections"][number]["components"][number];

function build(input: { datasetId: string; binding: (key: string) => string; sectionId: string; name: ReturnType<typeof localized>; components: (c: Builders) => Component[] }): NorthPanelDocument {
  const place = grid();
  let order = 0;
  const reference = (key: string) => ({ sourceType: "dataset" as const, sourceId: input.binding(key), datasetId: input.datasetId });
  const make = (id: string, type: string, props: Json, bindingKey: string | null, layout: Place): Component =>
    ({ id, type, schemaVersion: 1, props, bindings: bindingKey ? { result: reference(bindingKey) } : {}, layout, order: order++ });
  const builders: Builders = {
    heading: (id, es, en, level, x, y, w, h = 1) => make(id, "heading", { text: localized(es, en), level }, null, place(x, y, w, h)),
    paragraph: (id, es, en, x, y, w, h = 2) => {
      const doc = (value: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
      return make(id, "rich_text", { documents: { es: doc(es), en: doc(en) } }, null, place(x, y, w, h));
    },
    metric: (id, es, en, bindingKey, fieldKey, x, y, w) => make(id, "metric", { label: localized(es, en), fieldKey, format: "number" }, bindingKey, place(x, y, w, 2)),
    table: (id, bindingKey, x, y, w, h) => make(id, "table", { columns: [{ key: "result", label: localized("Resultado", "Result") }], rows: [], striped: true }, bindingKey, place(x, y, w, h)),
    bar: (id, es, en, bindingKey, categoryKey, seriesKey, seriesEs, seriesEn, color, x, y, w, h) =>
      make(id, "bar_chart", { title: localized(es, en), categoryKey, series: [{ key: seriesKey, label: localized(seriesEs, seriesEn), color }], height: 320, horizontal: true, variant: "grouped" }, bindingKey, place(x, y, w, h)),
    line: (id, es, en, bindingKey, categoryKey, seriesKey, seriesEs, seriesEn, color, x, y, w, h) =>
      make(id, "line_chart", { title: localized(es, en), categoryKey, series: [{ key: seriesKey, label: localized(seriesEs, seriesEn), color }], height: 280, variant: "area" }, bindingKey, place(x, y, w, h)),
    donut: (id, es, en, bindingKey, categoryKey, valueKey, color, x, y, w, h) =>
      make(id, "donut_chart", { title: localized(es, en), categoryKey, valueKey, color, height: 300, variant: "donut" }, bindingKey, place(x, y, w, h)),
    list: (id, items, x, y, w, h) => make(id, "list", { items: items.map(([key, es, en]) => ({ id: key, text: localized(es, en) })) }, null, place(x, y, w, h)),
  };
  return {
    schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
    sections: [{ id: input.sectionId, name: input.name, order: 0, layout: { variant: "grid", gap: "md" }, components: input.components(builders) }],
  };
}

type Builders = {
  heading: (id: string, es: string, en: string, level: number, x: number, y: number, w: number, h?: number) => Component;
  paragraph: (id: string, es: string, en: string, x: number, y: number, w: number, h?: number) => Component;
  metric: (id: string, es: string, en: string, bindingKey: string, fieldKey: string, x: number, y: number, w: number) => Component;
  table: (id: string, bindingKey: string, x: number, y: number, w: number, h: number) => Component;
  bar: (id: string, es: string, en: string, bindingKey: string, categoryKey: string, seriesKey: string, seriesEs: string, seriesEn: string, color: string, x: number, y: number, w: number, h: number) => Component;
  line: (id: string, es: string, en: string, bindingKey: string, categoryKey: string, seriesKey: string, seriesEs: string, seriesEn: string, color: string, x: number, y: number, w: number, h: number) => Component;
  donut: (id: string, es: string, en: string, bindingKey: string, categoryKey: string, valueKey: string, color: string, x: number, y: number, w: number, h: number) => Component;
  list: (id: string, items: Array<[string, string, string]>, x: number, y: number, w: number, h: number) => Component;
};

const containers = (name: string, groupBy: string[], extra: Measure[], limit: number, order: Array<{ key: string; direction: "ASC" | "DESC" }> = [{ key: "containers", direction: "DESC" }]): BindingSpec => ({
  key: name, name: `Master House: ${name}`,
  query: aggregate({ groupBy, measures: [distinctContainers, ...extra], orderBy: order, limit }),
});
const total = (key: string, measure: Measure): BindingSpec => ({
  key, name: `Master House: ${key}`, query: aggregate({ measures: [measure] }),
});

const TEAL = "#0F766E";
const BLUE = "#2563EB";

export const masterHouseCategory = {
  slug: "master-house",
  name: localized("Master House", "Master House"),
  icon: "Ship",
  order: 0,
};

export const masterHousePages: PageSpec[] = [
  {
    subcategory: { slug: "dashboard-information", name: localized("Información del tablero", "Dashboard information"), order: 0 },
    panel: { slug: "overview", name: localized("Resumen", "Overview") },
    filters: [DATE],
    bindings: [
      total("records", () => ({ operation: "COUNT", alias: "records" })),
      total("unique-containers", distinctContainers),
      total("unique-master-bills", (id) => ({ operation: "COUNT_DISTINCT", fieldId: id("master_bill_number"), alias: "master_bills" })),
      total("unique-house-bills", (id) => ({ operation: "COUNT_DISTINCT", fieldId: id("house_bill_number"), alias: "house_bills" })),
    ],
    document: ({ datasetId, binding }) => build({
      datasetId, binding, sectionId: "overview", name: localized("Información del tablero", "Dashboard information"),
      components: (c) => [
        c.heading("overview-title", "Importaciones Master-House", "Imports Master-House", 2, 0, 0, 12),
        c.paragraph("overview-scope", "Este reporte detalla los agentes declarados en los BL Master de contenedores de importación recibidos por los puertos de Panamá. Las cifras se expresan en contenedores y toneladas métricas. Todos los datos de esta demostración son FICTICIOS y cubren junio de 2026.", "This report details the agents declared in Master Bills of Lading for import containers received through Panama's ports. Figures are in containers and metric tons. All data in this demonstration is FICTITIOUS and covers June 2026.", 0, 1, 12, 3),
        c.metric("overview-records", "Registros", "Records", "records", "records", 0, 4, 3),
        c.metric("overview-containers", "Contenedores únicos", "Unique containers", "unique-containers", "containers", 3, 4, 3),
        c.metric("overview-master-bills", "BL master", "Master bills", "unique-master-bills", "master_bills", 6, 4, 3),
        c.metric("overview-house-bills", "BL house", "House bills", "unique-house-bills", "house_bills", 9, 4, 3),
        c.list("overview-navigation", [
          ["nav-search", "Search By: busca por consignatario Master y/o House.", "Search By: search by Master and/or House consignee."],
          ["nav-master", "Master Consignee List: inventario por consignatario Master.", "Master Consignee List: inventory by Master consignee."],
          ["nav-house", "House Consignee List: inventario por consignatario House.", "House Consignee List: inventory by House consignee."],
          ["nav-port", "Search by Port of Departure: filtra por puerto de salida.", "Search by Port of Departure: filter by loading port."],
          ["nav-cargo", "Consignees and Cargo Table: detalle por consignatario y carga.", "Consignees and Cargo Table: detail by consignee and cargo."],
          ["nav-table", "Consignees Table: consignatarios Master y House.", "Consignees Table: Master and House consignees."],
          ["nav-ff", "Top Freight Forwarders: ranking por BL Master declarados.", "Top Freight Forwarders: ranking by declared Master BLs."],
        ], 0, 6, 12, 5),
      ],
    }),
  },
  {
    subcategory: { slug: "search-by", name: localized("Search By", "Search By"), order: 1 },
    panel: { slug: "master-house-consignee", name: localized("Búsqueda Master – House", "Search by Master – House consignee") },
    filters: [text("master_consignee"), text("house_consignee"), exact("master_port_arrival"), text("house_port_departure"), exact("house_country_origin"), DATE],
    bindings: [
      containers("search-table", ["master_consignee", "house_consignee"], [sum("house_metric_tons", "weight_mt")], 50),
      total("search-containers", distinctContainers),
      containers("search-origin", ["house_country_origin"], [], 10),
      containers("search-carrier", ["house_carrier"], [], 6),
    ],
    document: ({ binding, datasetId, id }) => build({
      datasetId, binding, sectionId: "search-by", name: localized("Búsqueda Master – House", "Search by Master – House consignee"),
      components: (c) => [
        c.heading("search-title", "Contenedores y peso (MT) por consignatario Master y House", "Containers and weight (MT) by Master and House consignee", 2, 0, 0, 12),
        c.metric("search-total", "Contenedores únicos", "Unique containers", "search-containers", "containers", 0, 1, 4),
        c.table("search-grid", "search-table", 0, 3, 7, 9),
        c.bar("search-origin-chart", "Contenedores por país de origen", "Containers by origin country", "search-origin", id("house_country_origin"), "containers", "Contenedores", "Containers", TEAL, 7, 3, 5, 5),
        c.donut("search-carrier-chart", "Volumen por línea naviera", "Volume per shipping line", "search-carrier", id("house_carrier"), "containers", BLUE, 7, 8, 5, 5),
      ],
    }),
  },
  {
    subcategory: { slug: "master-consignee-list", name: localized("Master Consignee List", "Master Consignee List"), order: 2 },
    panel: { slug: "master-consignees", name: localized("Consignatarios Master", "Master consignees") },
    filters: [text("master_consignee"), exact("master_port_arrival"), text("master_carrier"), exact("master_country_origin"), text("master_port_departure"), DATE],
    bindings: [
      containers("master-list-table", ["master_consignee"], [sum("master_teus", "teus")], 50),
      total("master-list-weight", sum("master_metric_tons", "master_weight_mt")),
      containers("master-list-origin", ["master_country_origin"], [], 10),
      containers("master-list-carrier", ["master_carrier"], [], 6),
    ],
    document: ({ binding, datasetId, id }) => build({
      datasetId, binding, sectionId: "master-consignees", name: localized("Consignatarios Master", "Master consignees"),
      components: (c) => [
        c.heading("master-list-title", "Contenedores y TEUs por consignatario Master", "Containers and TEUs by Master consignee", 2, 0, 0, 12),
        c.metric("master-list-total", "Toneladas métricas Master", "Master metric tons", "master-list-weight", "master_weight_mt", 0, 1, 4),
        c.table("master-list-grid", "master-list-table", 0, 3, 7, 9),
        c.bar("master-list-origin-chart", "Contenedores por país de origen", "Containers by origin country", "master-list-origin", id("master_country_origin"), "containers", "Contenedores", "Containers", TEAL, 7, 3, 5, 5),
        c.donut("master-list-carrier-chart", "Volumen por línea naviera", "Volume per shipping line", "master-list-carrier", id("master_carrier"), "containers", BLUE, 7, 8, 5, 5),
      ],
    }),
  },
  {
    subcategory: { slug: "house-consignee-list", name: localized("House Consignee List", "House Consignee List"), order: 3 },
    panel: { slug: "house-consignees", name: localized("Consignatarios House", "House consignees") },
    filters: [text("house_consignee"), exact("house_port_arrival"), text("house_carrier"), exact("house_country_origin"), text("house_port_departure"), DATE],
    bindings: [
      containers("house-list-table", ["house_consignee"], [sum("house_metric_tons", "weight_mt")], 50),
      { key: "house-list-daily", name: "Master House: house-list-daily", query: aggregate({ groupBy: ["arrival_date"], measures: [sum("house_metric_tons", "weight_mt")], orderBy: [{ key: "arrival_date", direction: "ASC" }], limit: 31 }) },
      containers("house-list-origin", ["house_country_origin"], [], 10),
      containers("house-list-carrier", ["house_carrier"], [], 6),
    ],
    document: ({ binding, datasetId, id }) => build({
      datasetId, binding, sectionId: "house-consignees", name: localized("Consignatarios House", "House consignees"),
      components: (c) => [
        c.heading("house-list-title", "Contenedores y peso (MT) por consignatario House", "Containers and weight (MT) by House consignee", 2, 0, 0, 12),
        c.table("house-list-grid", "house-list-table", 0, 1, 7, 9),
        c.line("house-list-daily-chart", "Peso por día de llegada (MT)", "Weight per arrival day (MT)", "house-list-daily", id("arrival_date"), "weight_mt", "Peso (MT)", "Weight (MT)", TEAL, 7, 1, 5, 4),
        c.bar("house-list-origin-chart", "Contenedores por país de origen", "Containers by origin country", "house-list-origin", id("house_country_origin"), "containers", "Contenedores", "Containers", BLUE, 7, 5, 5, 5),
        c.donut("house-list-carrier-chart", "Volumen por línea naviera", "Volume per shipping line", "house-list-carrier", id("house_carrier"), "containers", TEAL, 7, 10, 5, 5),
      ],
    }),
  },
  {
    subcategory: { slug: "search-by-port-of-departure", name: localized("Búsqueda por puerto de salida", "Search by Port of Departure"), order: 4 },
    panel: { slug: "port-of-departure", name: localized("Puerto de salida", "Port of departure") },
    filters: [text("master_consignee"), exact("master_port_arrival"), text("master_port_departure"), text("master_bill_number"), DATE],
    bindings: [
      total("departure-teus", sum("master_teus", "master_teus")),
      containers("departure-table", ["master_consignee", "master_port_arrival"], [sum("master_teus", "teus")], 50),
      containers("departure-consignees", ["master_consignee"], [], 8),
      { key: "departure-daily", name: "Master House: departure-daily", query: aggregate({ groupBy: ["arrival_date"], measures: [distinctContainers], orderBy: [{ key: "arrival_date", direction: "ASC" }], limit: 31 }) },
      containers("departure-ports", ["master_port_departure"], [], 8),
      containers("departure-entry", ["master_port_arrival"], [], 6),
    ],
    document: ({ binding, datasetId, id }) => build({
      datasetId, binding, sectionId: "port-of-departure", name: localized("Puerto de salida", "Port of departure"),
      components: (c) => [
        c.heading("departure-title", "Contenedores por consignatario Master y puerto de arribo", "Containers by Master consignee and port of arrival", 2, 0, 0, 12),
        c.metric("departure-teus-total", "TEUs Master", "Master TEUs", "departure-teus", "master_teus", 0, 1, 4),
        c.table("departure-grid", "departure-table", 0, 3, 7, 9),
        c.bar("departure-consignee-chart", "Contenedores por consignatario Master", "Containers by Master consignee", "departure-consignees", id("master_consignee"), "containers", "Contenedores", "Containers", TEAL, 7, 3, 5, 5),
        c.line("departure-daily-chart", "Contenedores por día de llegada", "Containers per arrival day", "departure-daily", id("arrival_date"), "containers", "Contenedores", "Containers", BLUE, 0, 12, 12, 4),
        c.donut("departure-port-chart", "Contenedores por puerto de salida", "Containers per departure port", "departure-ports", id("master_port_departure"), "containers", TEAL, 0, 16, 6, 5),
        c.donut("departure-entry-chart", "Contenedores por puerto de arribo", "Containers per entry port", "departure-entry", id("master_port_arrival"), "containers", BLUE, 6, 16, 6, 5),
      ],
    }),
  },
  {
    subcategory: { slug: "consignees-and-cargo-table", name: localized("Consignatarios y carga", "Consignees and Cargo Table"), order: 5 },
    panel: { slug: "consignees-cargo", name: localized("Consignatarios y carga", "Consignees and cargo") },
    filters: [text("house_consignee"), exact("house_country_origin"), text("house_port_departure"), DATE],
    bindings: [
      total("cargo-weight", sum("house_metric_tons", "house_weight_mt")),
      containers("cargo-table", ["house_consignee", "house_port_departure"], [sum("house_metric_tons", "weight_mt")], 100),
    ],
    document: ({ binding, datasetId }) => build({
      datasetId, binding, sectionId: "consignees-cargo", name: localized("Consignatarios y carga", "Consignees and cargo"),
      components: (c) => [
        c.heading("cargo-title", "Contenedores y peso (MT) por consignatario House y puerto de salida", "Containers and weight (MT) by House consignee and departure port", 2, 0, 0, 12),
        c.metric("cargo-total", "Peso House (MT)", "House weight (MT)", "cargo-weight", "house_weight_mt", 0, 1, 4),
        c.table("cargo-grid", "cargo-table", 0, 3, 12, 11),
      ],
    }),
  },
  {
    subcategory: { slug: "consignees-table", name: localized("Tabla de consignatarios", "Consignees Table"), order: 6 },
    panel: { slug: "consignees", name: localized("Consignatarios", "Consignees") },
    filters: [text("master_consignee"), text("house_consignee"), exact("master_country_origin"), text("master_port_departure"), DATE],
    bindings: [
      containers("consignees-table", ["master_consignee", "house_consignee"], [sum("house_metric_tons", "weight_mt")], 100, [{ key: "weight_mt", direction: "DESC" }]),
    ],
    document: ({ binding, datasetId }) => build({
      datasetId, binding, sectionId: "consignees", name: localized("Consignatarios", "Consignees"),
      components: (c) => [
        c.heading("consignees-title", "Consignatarios Master y House por toneladas métricas", "Master and House consignees by metric tons", 2, 0, 0, 12),
        c.table("consignees-grid", "consignees-table", 0, 1, 12, 12),
      ],
    }),
  },
  {
    subcategory: { slug: "top-freight-forwarders", name: localized("Top freight forwarders", "Top Freight Forwarders"), order: 7 },
    panel: { slug: "top-freight-forwarders", name: localized("Top freight forwarders (BL Master)", "Top freight forwarders (Master BL)") },
    filters: [text("master_consignee"), exact("master_country_origin"), DATE],
    bindings: [
      containers("forwarders-table", ["master_consignee"], [sum("master_teus", "teus")], 15),
      containers("forwarders-chart", ["master_consignee"], [], 15),
    ],
    document: ({ binding, datasetId, id }) => build({
      datasetId, binding, sectionId: "forwarders", name: localized("Top freight forwarders", "Top freight forwarders"),
      components: (c) => [
        c.heading("forwarders-title", "Principales freight forwarders en importaciones (BL Master)", "Top freight forwarders for imports (Master BL)", 2, 0, 0, 12),
        c.table("forwarders-grid", "forwarders-table", 0, 1, 7, 9),
        c.bar("forwarders-bars", "Contenedores por freight forwarder", "Containers per freight forwarder", "forwarders-chart", id("master_consignee"), "containers", "Contenedores", "Containers", BLUE, 7, 1, 5, 9),
      ],
    }),
  },
];
