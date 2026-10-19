// SHARK · "Local Import" report: nine pages provisioned into the category `local-import` (matched by slug; nothing is duplicated), over the
// existing dataset `local-import`. Only fields that already exist are used; no data is added or derived by hand.
//
//   node scripts/provision-view.mjs scripts/dashboards/shark-local-import.mjs --org shark [--only <panel-slug>] [--publish]
//
// Pages: Info, HS Code, then Category / Importer (+ Imports Table for Maritime) for each customs location. The location is a fixed page filter on
// `transport_method` (SEA = Maritime, LAND = Overland / Bonds, AIR = Air), so the three categories share one design.
// Metrics (all SUM over the rows of the selection): Gross Weight (Kg.) = gross_weight_kg, CIF Value (USD) = cif_value_usd, Freight (USD) = freight_usd.
const ES = {
  "HS Code": "Código HS", "Maritime ports - Category": "Puertos marítimos - Categoría", "Maritime - Importer Card": "Marítimo - Ficha del importador",
  "Maritime - Imports Table": "Marítimo - Tabla de importaciones", "Overland / Bonds - Category": "Terrestre / Depósitos - Categoría",
  "Overland / Bonds - Importer Card": "Terrestre / Depósitos - Ficha del importador", "Air - Category": "Aéreo - Categoría", "Air - Importer Card": "Aéreo - Ficha del importador",
  "Precedence Country by Gross Weight/CIF": "País de procedencia por peso bruto/CIF", "CIF Value by Origin": "Valor CIF por origen",
  "Gross Weight by Place of Arrival": "Peso bruto por lugar de arribo", "Importers by Gross Weight / CIF": "Importadores por peso bruto / CIF",
  "Gross Weight by Procedence Country": "Peso bruto por país de procedencia", "Gross Weight by Product Description": "Peso bruto por descripción de producto",
  "Gross Weight by Month": "Peso bruto por mes", "Gross Weight (Kg.)": "Peso bruto (Kg.)", "CIF Value (USD)": "Valor CIF (USD)", "Freight (USD)": "Flete (USD)",
  "Month / Year": "Mes / Año", "Importer": "Importador", "HS Description": "Descripción HS", "Port of Arrival": "Puerto de arribo",
  "Country of Precedence": "País de procedencia", "Transport Method": "Medio de transporte", "Year": "Año", "Month": "Mes", "Grand total": "Total general",
};
const l = (a, b) => (b === undefined ? { es: ES[a] ?? a, en: a } : { es: a, en: b });
const measure = (operation, fieldId, alias, extra = {}) => ({ operation, ...(fieldId ? { fieldId } : {}), ...extra, alias });
const agg = (spec) => ({ mode: "AGGREGATE", ...spec });
const TEXT_OPS = ["IN", "EQ"];
const DATE_OPS = ["GTE", "LTE"];
const text = (key) => ({ key, operators: TEXT_OPS });
const when = (key) => ({ key, operators: DATE_OPS });

const BLUE = "#2F6FED"; const SKY = "#38BDF8";
const YEAR_COLORS = { 2025: BLUE, 2026: SKY };
const YEARS = [2025, 2026];
const ROW_HEIGHT = 16;

/** The three customs-clearance locations: one design, one transport method each. */
const LOCATIONS = [
  { id: "maritime", transport: "SEA", name: "Maritime", category: "Maritime ports - Category", importer: "Maritime - Importer Card", table: "Maritime - Imports Table", icon: "ship", tone: "blue",
    blurb: l("Embarques por puertos de contenedores y de carga.", "Shipments through container and cargo ports.") },
  { id: "overland", transport: "LAND", name: "Overland / Bonds", category: "Overland / Bonds - Category", importer: "Overland / Bonds - Importer Card", icon: "truck", tone: "amber",
    blurb: l("Embarques por puestos fronterizos y depósitos aduaneros.", "Shipments through border posts and customs bonds.") },
  { id: "air", transport: "AIR", name: "Air", category: "Air - Category", importer: "Air - Importer Card", icon: "globe", tone: "cyan",
    blurb: l("Embarques por aeropuertos y terminales de carga aérea.", "Shipments through airports and air-cargo terminals.") },
];

export default {
  datasetSlug: "local-import",
  category: { name: l("Local Import"), slug: "local-import", icon: "ship", color: "#2F6FED" },

  panels: [
    // 1 · Info — static copy, no filters, no charts, title bar without text
    panel({
      subcategory: { name: l("Info"), slug: "info", icon: "info" },
      panel: { name: l("Info"), slug: "info", icon: "info", audienceType: "ALL_MEMBERS" },
      filters: [],
      bindings: () => [],
      items: () => [
        // The title bar is empty by design; the schema needs a non-blank string, so it holds a zero-width space.
        titleBar("Info", { es: "​", en: "​" }),
        item("hero", "hero", {
          title: l("IMPORT DECLARATIONS"),
          body: l(
            "Información de embarques despachados que llegan por puertos de contenedores, aeropuertos, puestos fronterizos y zonas francas de Panamá, según lo declarado a las autoridades aduaneras. Incluye importaciones en contenedores, granel y carga fraccionada. Excluye importaciones de vehículos, efectos personales y Zona Libre de Colón (ZLC).",
            "Information on cleared shipments arriving through Panama's container ports, airports, border posts and free zones, as declared to customs authorities. It includes containerized, bulk and break-bulk imports. It excludes imports of vehicles, personal effects and the Colón Free Zone (ZLC)."),
          showBrand: true, centered: true, backgroundImage: "/brand/shark-port-hero.webp", logoImage: "/brand/shark-logo.png",
        }, {}, { x: 0, y: 2, w: 12, h: 22 }, { w: 12, h: 22 }),
        item("notes", "definition_list", {
          title: l("Cómo leer las cifras", "How to read the figures"), icon: "info",
          items: [
            { id: "units", icon: "scale", tone: "blue", term: l("Unidades", "Units"), text: l("Todas las métricas se presentan en peso bruto (Kilogramos / Toneladas Métricas) y valor CIF (USD).", "All metrics are shown in gross weight (kilograms / metric tons) and CIF value (USD).") },
            { id: "updated", icon: "calendar", tone: "slate", term: l("Actualización", "Updated through"), text: l("Datos hasta abril de 2026.", "Data through April 2026.") },
            { id: "hs", icon: "list", tone: "violet", term: l("HS Code", "HS Code"), text: l("La pestaña HS Code permite buscar por los primeros 4 dígitos del código HS o por la descripción del producto para relacionar códigos con descripciones.", "The HS Code tab lets you search by the first 4 digits of the HS code or by product description to match codes with descriptions.") },
          ],
        }, {}, { x: 0, y: 24, w: 12, h: 7 }, { w: 12, h: 10 }),
        item("nav", "link_cards", {
          title: l("Report Categories by Customs Clearance Location", "Report Categories by Customs Clearance Location"), icon: "book",
          items: LOCATIONS.map((loc, index) => ({ id: loc.id, panelSlug: `${loc.id}-category`, icon: loc.icon, tone: loc.tone, title: l(`${index + 1}. ${loc.name}`, `${index + 1}. ${loc.name}`), description: loc.blurb })),
        }, {}, { x: 0, y: 31, w: 12, h: 6 }, { w: 12, h: 9 }),
        item("views", "definition_list", {
          title: l("Each Category Contains Two Main Views:", "Each Category Contains Two Main Views:"), icon: "bars",
          items: [
            { id: "category", icon: "chart", tone: "blue", term: l("Category", "Category"), text: l("Desglose detallado de embarques por empresa importadora. El panel resumen muestra peso bruto total en toneladas métricas (MT), valor CIF en USD y valor de flete declarado en USD. Los gráficos ilustran desgloses por lugar de despacho, países de origen y descripciones de producto.", "Detailed breakdown of shipments by importing company. The summary panel shows total gross weight in metric tons (MT), CIF value in USD and declared freight value in USD. The charts show breakdowns by clearance location, countries of origin and product descriptions.") },
            { id: "importer", icon: "users", tone: "violet", term: l("Importer", "Importer"), text: l("Búsqueda de importaciones por código arancelario (Product HS) o descripción del producto. Muestra embarques detallados por país de origen, nombre del importador y lugar de despacho (puerto, aeropuerto o depósito aduanero). Datos en peso bruto (MT) y valor CIF (USD).", "Search of imports by tariff code (Product HS) or product description. It shows detailed shipments by country of origin, importer name and clearance location (port, airport or customs bond). Data in gross weight (MT) and CIF value (USD).") },
          ],
        }, {}, { x: 0, y: 37, w: 12, h: 8 }, { w: 12, h: 12 }),
        item("privacy", "link", { label: l("Política de privacidad", "Privacy Policy"), href: "https://blackpolar.org/en/legal/privacy", variant: "secondary", openInNewTab: true }, {}, { x: 0, y: 45, w: 12, h: 2 }, { w: 12, h: 2 }),
      ],
    }),

    // 2 · HS Code — one detailed table across all transport methods
    panel({
      subcategory: { name: l("HS Code"), slug: "hs-code", icon: "list" },
      panel: { name: l("HS Code"), slug: "hs-code", icon: "list", audienceType: "ALL_MEMBERS" },
      filters: [text("hsCode"), text("hsDesc"), text("importer"), text("transport"), when("date")],
      bindings: ({ f, rows }) => [
        { name: "results", query: agg({
          groupBy: [f.date, f.importer, f.hsCode, f.hsDesc], granularity: { [f.date]: "MONTH" },
          measures: [measure("MIN", f.date, "year_ref"), rows],
          orderBy: [{ key: f.hsCode, direction: "ASC" }], limit: 200, includeTotal: true, searchFieldIds: [f.importer, f.hsCode, f.hsDesc],
        }) },
      ],
      items: ({ f, binding }) => [
        titleBar("HS Code", l("HS Code")),
        filterBar(),
        item("table", "data_grid", dataGrid("HS Code", [
          col("year_ref", "Year", "year", 70), col(f.date, "Month", "month", 90), col(f.importer, "Importer", "text", 280),
          col(f.hsCode, "HS Code", "text", 120), col(f.hsDesc, "HS Description", "text", 420),
        ], { defaultSort: { key: f.hsCode, direction: "ASC" }, pageSizes: [20, 50, 100, 200], defaultPageSize: 50 }), { data: binding("results") }, { x: 0, y: 4, w: 12, h: 30 }, { h: 24 }),
      ],
    }),

    ...LOCATIONS.flatMap((loc) => [
      // 3 · Category
      panel({
        subcategory: { name: l(loc.category), slug: `${loc.id}-category`, icon: loc.icon },
        panel: { name: l(loc.category), slug: `${loc.id}-category`, icon: loc.icon, audienceType: "ALL_MEMBERS" },
        filters: [text("country"), text("poa"), when("date"), text("hsDesc"), text("importer")],
        pageFilters: ({ f }) => [{ fieldId: f.transport, operator: "EQ", value: loc.transport }],
        bindings: ({ f, gross, cif }) => [
          { name: "countries", query: agg({ groupBy: [f.country], measures: [gross, cif], orderBy: [{ key: "gross", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.country] }) },
          { name: "origins", query: agg({ groupBy: [f.country], measures: [gross, cif], orderBy: [{ key: "cif", direction: "DESC" }], limit: 200 }) },
          { name: "arrival_ports", query: agg({ groupBy: [f.poa], measures: [gross], orderBy: [{ key: "gross", direction: "DESC" }], limit: 30 }) },
          { name: "importers", query: agg({ groupBy: [f.importer], measures: [gross, cif], orderBy: [{ key: "gross", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.importer] }) },
          { name: "grand_total", query: agg({ measures: [gross, cif] }) },
        ],
        items: ({ f, binding }) => [
          titleBar(loc.category, l(loc.category)),
          filterBar(),
          item("countries", "data_grid", { ...dataGrid("Precedence Country by Gross Weight/CIF", [col("rank", "#", "rank", 48), col(f.country, "Country of Precedence", "text", 170), col("gross", "Gross Weight (Kg.)", "number", 130, { align: "right" })], { search: true, exportable: false, defaultSort: { key: "gross", direction: "DESC" } }), totals: { binding: "totals", label: l("Grand total") } }, { data: binding("countries"), totals: binding("grand_total") }, { x: 0, y: 4, w: 3, h: 22 }, { h: 14 }),
          item("map", "geo_map", { title: l("CIF Value by Origin"), regionKey: f.country, valueKey: "cif", valueLabel: l("CIF Value (USD)"), tone: "blue" }, { data: binding("origins") }, { x: 3, y: 4, w: 5, h: 11 }, { h: 12 }),
          item("arrival", "donut_chart", donutProps("Gross Weight by Place of Arrival", f.poa, "gross", "Gross Weight (Kg.)"), { data: binding("arrival_ports"), total: binding("grand_total") }, { x: 3, y: 15, w: 5, h: 11 }, { h: 10 }),
          item("importers", "data_grid", { ...dataGrid("Importers by Gross Weight / CIF", [col("rank", "#", "rank", 48), col(f.importer, "Importer", "text", 230), col("gross", "Gross Weight (Kg.)", "number", 130, { align: "right" })], { search: true, exportable: false, defaultSort: { key: "gross", direction: "DESC" } }), totals: { binding: "totals", label: l("Grand total") } }, { data: binding("importers"), totals: binding("grand_total") }, { x: 8, y: 4, w: 4, h: 22 }, { h: 14 }),
        ],
      }),

      // 4 · Importer card
      panel({
        subcategory: { name: l(loc.importer), slug: `${loc.id}-importer`, icon: "users" },
        panel: { name: l(loc.importer), slug: `${loc.id}-importer`, icon: "users", audienceType: "ALL_MEMBERS" },
        filters: [text("importer"), when("date"), text("poa"), text("country")],
        pageFilters: ({ f }) => [{ fieldId: f.transport, operator: "EQ", value: loc.transport }],
        bindings: ({ f, gross, cif, freight }) => [
          { name: "totals", query: agg({ measures: [gross, cif, freight] }) },
          { name: "origins", query: agg({ groupBy: [f.country], measures: [gross], orderBy: [{ key: "gross", direction: "DESC" }], limit: 200 }) },
          { name: "arrival_ports", query: agg({ groupBy: [f.poa], measures: [gross], orderBy: [{ key: "gross", direction: "DESC" }], limit: 30 }) },
          { name: "products", query: agg({ groupBy: [f.hsDesc], measures: [gross], orderBy: [{ key: "gross", direction: "DESC" }], limit: 10 }) },
          { name: "monthly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "MONTH_OF_YEAR" }, measures: yearMeasures(f), orderBy: [{ key: f.date, direction: "ASC" }], limit: 12 }) },
        ],
        items: ({ f, binding }) => [
          titleBar(loc.importer, l(loc.importer)),
          filterBar(),
          kpi("kpi-gross", "Gross Weight (Kg.)", "gross", "scale", "blue", binding("totals"), { x: 0, y: 4, w: 4, h: 3 }),
          kpi("kpi-cif", "CIF Value (USD)", "cif", "chart", "violet", binding("totals"), { x: 4, y: 4, w: 4, h: 3 }),
          kpi("kpi-freight", "Freight (USD)", "freight", "ship", "cyan", binding("totals"), { x: 8, y: 4, w: 4, h: 3 }),
          item("map", "geo_map", { title: l("Gross Weight by Procedence Country"), regionKey: f.country, valueKey: "gross", valueLabel: l("Gross Weight (Kg.)"), tone: "blue" }, { data: binding("origins") }, { x: 0, y: 7, w: 5, h: 13 }, { h: 12 }),
          item("arrival", "donut_chart", donutProps("Gross Weight by Place of Arrival", f.poa, "gross", "Gross Weight (Kg.)"), { data: binding("arrival_ports"), total: binding("totals") }, { x: 5, y: 7, w: 3, h: 13 }, { h: 10 }),
          item("products", "bar_chart", { title: l("Gross Weight by Product Description"), categoryKey: f.hsDesc, series: [{ key: "gross", label: l("Gross Weight (Kg.)"), color: BLUE }], horizontal: true, showValues: true, height: 300 }, { data: binding("products") }, { x: 8, y: 7, w: 4, h: 13 }, { h: 12 }),
          item("monthly", "line_chart", { title: l("Gross Weight by Month"), categoryKey: f.date, categoryFormat: "monthOfYear", series: YEARS.map((year) => ({ key: `y${year}`, label: l(String(year), String(year)), color: YEAR_COLORS[year] })), variant: "line", height: 240 }, { data: binding("monthly") }, { x: 0, y: 20, w: 12, h: 10 }, { h: 9 }),
        ],
      }),

      // 5 · Imports table (Maritime only, as specified)
      ...(loc.table ? [panel({
        subcategory: { name: l(loc.table), slug: `${loc.id}-imports-table`, icon: "list" },
        panel: { name: l(loc.table), slug: `${loc.id}-imports-table`, icon: "list", audienceType: "ALL_MEMBERS" },
        filters: [text("importer"), when("date"), text("hsDesc"), text("poa"), text("country")],
        pageFilters: ({ f }) => [{ fieldId: f.transport, operator: "EQ", value: loc.transport }],
        bindings: ({ f, gross, cif }) => [
          { name: "results", query: agg({
            groupBy: [f.date, f.importer, f.hsDesc, f.country, f.poa], granularity: { [f.date]: "MONTH" },
            measures: [measure("MIN", f.date, "year_ref"), gross, cif],
            orderBy: [{ key: "gross", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.importer, f.hsDesc, f.country, f.poa],
          }) },
        ],
        items: ({ f, binding }) => [
          titleBar(loc.table, l(loc.table)),
          filterBar(),
          item("table", "data_grid", dataGrid(loc.table, [
            col("year_ref", "Year", "year", 70), col(f.date, "Month", "month", 90), col(f.importer, "Importer", "text", 240), col(f.hsDesc, "HS Description", "text", 260),
            col(f.country, "Country of Precedence", "text", 160), col(f.poa, "Port of Arrival", "text", 200),
            col("gross", "Gross Weight (Kg.)", "number", 130, { align: "right" }), col("cif", "CIF Value (USD)", "number", 130, { align: "right" }),
          ], { defaultSort: { key: "gross", direction: "DESC" }, pageSizes: [20, 50, 100, 200], defaultPageSize: 50 }), { data: binding("results") }, { x: 0, y: 4, w: 12, h: 30 }, { h: 24 }),
        ],
      })] : []),
    ]),
  ],
};

// ─── builders (same contract as shark-import-ctr.mjs) ───────────────────────────────────────────────────────

/** Gross weight of each year in the same row (conditional measures over the arrival date). */
function yearMeasures(f) {
  return YEARS.map((year) => measure("SUM", f.gw, `y${year}`, { when: [{ fieldId: f.date, operator: "GTE", value: `${year}-01-01` }, { fieldId: f.date, operator: "LTE", value: `${year}-12-31` }] }));
}
const donutProps = (title, categoryKey, valueKey, center) => ({ title: l(title), categoryKey, valueKey, maxSlices: 5, totalKey: valueKey, height: 240, variant: "donut", showTotal: true, centerLabel: l(center), legend: "right" });

function panel(spec) {
  const keys = {
    date: "date", importer: "importer", hsCode: "hs_code", hsDesc: "hs_description", poa: "port_of_arrival", country: "country_of_precedence",
    gw: "gross_weight_kg", cifField: "cif_value_usd", freightField: "freight_usd", transport: "transport_method",
  };
  const fieldsOf = (fieldId) => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, fieldId(key)]));
  return {
    subcategory: spec.subcategory,
    panel: spec.panel,
    bindings: ({ fieldId }) => {
      const f = fieldsOf(fieldId);
      const gross = measure("SUM", f.gw, "gross");
      const cif = measure("SUM", f.cifField, "cif");
      const freight = measure("SUM", f.freightField, "freight");
      const rows = measure("COUNT", null, "rows");
      // The same allowlist on every binding keeps the filter bar, totals and every component consistent.
      const allowed = spec.filters.map((entry) => ({ fieldId: f[entry.key], operators: entry.operators }));
      const page = spec.pageFilters ? spec.pageFilters({ f }) : [];
      return spec.bindings({ f, gross, cif, freight, rows }).map((binding) => ({
        name: binding.name,
        query: page.length ? { ...binding.query, filters: [...(binding.query.filters ?? []), ...page] } : binding.query,
        allowedFilters: allowed,
      }));
    },
    document: ({ fieldId, binding }) => document(spec.panel.name, spec.items({ f: fieldsOf(fieldId), binding })),
  };
}

function item(id, type, props, bindings, desktop, tablet = {}, mobile = {}) {
  return { id, type, props, bindings, desktop, tablet: { ...tablet }, mobile: { ...mobile } };
}

function document(name, items) {
  const flow = (device) => {
    let x = 0; let y = 0; let rowHeight = 0;
    const placed = new Map();
    for (const entry of items) {
      const size = { w: 12, h: Math.max(2, entry.desktop.h > 6 ? Math.round(entry.desktop.h * 0.7) : entry.desktop.h), ...(entry[device] ?? {}) };
      if (entry.type === "kpi_card" && device === "tablet") size.w = 6;
      if (x + size.w > 12) { x = 0; y += rowHeight; rowHeight = 0; }
      placed.set(entry.id, { x, y, w: size.w, h: size.h });
      x += size.w; rowHeight = Math.max(rowHeight, size.h);
    }
    return placed;
  };
  const tablet = flow("tablet");
  const mobile = flow("mobile");
  return {
    schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
    sections: [{
      id: "dashboard", name, order: 0, layout: { variant: "grid", gap: "sm", rowHeight: ROW_HEIGHT, fit: true },
      components: items.map((entry, index) => ({
        id: entry.id, type: entry.type, schemaVersion: 1, props: entry.props, bindings: entry.bindings, order: index,
        layout: { desktop: entry.desktop, tablet: tablet.get(entry.id), mobile: { ...mobile.get(entry.id), w: 12, x: 0 } },
      })),
    }],
  };
}

const titleBar = (id, text) => item(`title-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, "title_bar", { text, align: "left" }, {}, { x: 0, y: 0, w: 12, h: 2 }, { h: 2 }, { h: 2 });
const FILTER_LABELS = {
  date: l("Month / Year"), importer: l("Importer"), hs_code: l("HS Code"), hs_description: l("HS Description"),
  port_of_arrival: l("Port of Arrival"), country_of_precedence: l("Country of Precedence"), transport_method: l("Transport Method"),
};
const filterBar = () => item("filters", "filter_bar", { title: l("Filtros", "Filters"), labels: FILTER_LABELS }, {}, { x: 0, y: 2, w: 12, h: 2 }, { h: 4 }, { h: 4 });
const kpi = (id, label, valueKey, icon, tone, data, desktop) => item(id, "kpi_card", { label: l(label), valueKey, format: "number", icon, tone, variant: "compact" }, { data }, desktop, { w: 6, h: 3 }, { w: 6, h: 3 });

const col = (key, label, kind, width, extra = {}) => ({ key, label: l(label), kind, sortable: kind !== "rank", width, ...extra });
function dataGrid(title, columns, options = {}) {
  const { search = true, exportable = true, defaultSort = { key: "gross", direction: "DESC" }, pageSizes = [10, 20, 30], defaultPageSize = 20 } = options;
  return { title: l(title), columns, pageSizes, defaultPageSize, defaultSort, searchable: search, selectable: false, exportable };
}
