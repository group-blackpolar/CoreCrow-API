// SHARK · "Imports CTRs" report: seven pages provisioned into the category `import-ctr` (matched by slug; nothing is duplicated), over the
// existing dataset `import-ctr`. Only fields that already exist are used; no data is added or derived by hand.
//
//   node scripts/provision-view.mjs scripts/dashboards/shark-import-ctr.mjs --org shark [--only <panel-slug>] [--publish]
//
// Metric rules (audited on the 796,260-row dataset, see docs/import-ctr.md):
//   Containers  COUNT of rows (one row = one container line; the source file counts rows, 796,260)
//   TEUs        SUM teus DISTINCT BY bill_of_lading_nbr   the TEU value belongs to the BL and is repeated on its rows (a plain SUM overstates by ~3.4%)
// Per-year series use conditional measures (`when`), month series group by calendar month number (MONTH_OF_YEAR).
const ES = {
  "Imports by Port": "Importaciones por puerto", "Imports by Year - Only containers with origin country": "Importaciones por año - Solo contenedores con país de origen",
  "Consignees by Port - Year Comparison": "Consignatarios por puerto - Comparación anual", "Table Consignee List": "Tabla de consignatarios",
  "Containers by Consignee": "Contenedores por consignatario", "Containers by Country of Origin": "Contenedores por país de origen",
  "Containers by Line/Agency": "Contenedores por línea/agencia", "Containers by Entry Port": "Contenedores por puerto de entrada", "Containers by month": "Contenedores por mes",
  "Containers by Year": "Contenedores por año", "Containers by Month and Year": "Contenedores por mes y año", "Containers by Region and Year": "Contenedores por región y año",
  "Containers by Month": "Contenedores por mes", "Containers by Origin": "Contenedores por origen", "Port of Departure": "Puerto de salida",
  "Containers by Port of Departure": "Contenedores por puerto de salida", "Share by Entry Port": "Participación por puerto de entrada", "Share by Line/Agency": "Participación por línea/agencia",
  "Month / Year": "Mes / Año", "Port of Arrival": "Puerto de arribo", "Carrier": "Naviera", "Consignee": "Consignatario", "Country of Origin": "País de origen", "Containers": "Contenedores",
  "Teus": "TEUs", "Year": "Año", "Month": "Mes", "Grand total": "Total general",
};
const l = (a, b) => (b === undefined ? { es: ES[a] ?? a, en: a } : { es: a, en: b });
const measure = (operation, fieldId, alias, extra = {}) => ({ operation, ...(fieldId ? { fieldId } : {}), ...extra, alias });
const agg = (spec) => ({ mode: "AGGREGATE", ...spec });
const TEXT_OPS = ["IN", "EQ"];
const DATE_OPS = ["GTE", "LTE"];
const text = (key) => ({ key, operators: TEXT_OPS });
const when = (key) => ({ key, operators: DATE_OPS });

const BLUE = "#2F6FED"; const GREEN = "#84CC16"; const GRAY = "#9AA0A6"; const RED = "#E53935";
const YEAR_COLORS = { 2024: GREEN, 2025: GRAY, 2026: RED };
const YEARS = [2024, 2025, 2026];
const ROW_HEIGHT = 16;
// The five terminals that carry 99.5% of the containers; each becomes one bar per year.
const MAIN_PORTS = [
  ["mit", "MANZANILLO INTERNATIONAL TERMINAL PANAMA, S.A."], ["balboa", "PANAMA PORTS COMPANY PPC BALBOA"], ["cct", "COLON CONTAINER TERMINAL, S.A."],
  ["psa", "PSA PANAMA INTERNATIONAL TERMINAL, S.A."], ["cristobal", "PANAMA PORTS COMPANY PPC CRISTÓBAL"],
];
const PORT_COLORS = [BLUE, "#7C5CFC", "#0FA3C4", "#D98A0B", "#1F9D63"];

export default {
  datasetSlug: "import-ctr",
  category: { name: l("Imports CTRs"), slug: "import-ctr", icon: "ship", color: "#2F6FED" },

  panels: [
    // 1 · Report Info — static copy, no filters, no charts
    panel({
      subcategory: { name: l("Report Info"), slug: "report-info", icon: "info" },
      panel: { name: l("Report Info"), slug: "report-info", icon: "info", audienceType: "ALL_MEMBERS" },
      filters: [],
      bindings: () => [],
      items: () => {
        const card = (id, panelSlug, icon, tone, title, description) => ({ id, panelSlug, icon, tone, title: l(title, title), description });
        return [
          titleBar("Report Info", l("Report Info")),
          item("hero", "hero", {
            eyebrow: l("REPORTE DE IMPORTACIONES", "IMPORTS REPORT"), title: l("IMPORTS CTRs"),
            body: l("Reporte de importaciones CTR: contenedores y TEUs por puerto de arribo, línea naviera, consignatario, país de origen y puerto de salida, con comparación anual y mensual. Todas las cifras salen de los registros importados.",
              "CTR imports report: containers and TEUs by port of arrival, shipping line, consignee, country of origin and port of departure, with yearly and monthly comparison. Every figure comes from the imported records."),
            chips: [{ icon: "container", label: l("Contenedores y TEUs", "Containers and TEUs") }, { icon: "calendar", label: l("Comparación 2024 – 2026", "2024 – 2026 comparison") }],
            showBrand: true, backgroundImage: "/brand/shark-port-hero.webp", logoImage: "/brand/shark-logo.png",
          }, {}, { x: 0, y: 2, w: 12, h: 6 }, { w: 12, h: 8 }),
          item("nav", "link_cards", {
            title: l("¿Qué incluye este reporte?", "What does this report include?"), icon: "book",
            items: [
              card("port", "port", "anchor", "blue", "Port", l("Contenedores y TEUs por puerto de arribo: consignatarios, país de origen, línea naviera y evolución mensual.", "Containers and TEUs by port of arrival: consignees, country of origin, shipping line and monthly evolution.")),
              card("year", "year-comparison", "calendar", "violet", "Year Comparison", l("Comparación 2024, 2025 y 2026 por año, puerto, mes y país de origen.", "2024, 2025 and 2026 compared by year, port, month and country of origin.")),
              card("detail", "consignee-details", "users", "cyan", "Consignee Details", l("Detalle de un consignatario: puertos, líneas, meses y orígenes.", "Detail of one consignee: ports, lines, months and origins.")),
              card("byport", "consignees-by-port", "buildings", "green", "Consignees by Port", l("Tabla de contenedores por consignatario y año.", "Containers by consignee and year.")),
              card("origin", "origin-port-detail", "pin", "amber", "Origin port Detail", l("Puertos de salida, consignatarios y participación por puerto y línea.", "Departure ports, consignees and share by port and line.")),
              card("list", "consignees-list", "list", "slate", "Table Consignees List", l("Listado detallado por año, mes, consignatario, origen y puertos.", "Detailed list by year, month, consignee, origin and ports.")),
            ],
          }, {}, { x: 0, y: 8, w: 8, h: 12 }, { w: 12, h: 16 }),
          item("units", "definition_list", {
            title: l("Métricas", "Metrics"), icon: "info",
            items: [
              { id: "containers", icon: "container", tone: "blue", term: l("Containers"), text: l("Número de registros (filas) de contenedor.", "Number of container records (rows).") },
              { id: "teus", icon: "container", tone: "violet", term: l("TEUs"), text: l("Se cuentan una vez por conocimiento de embarque (Bill of Lading).", "Counted once per bill of lading.") },
              { id: "year", icon: "calendar", tone: "slate", term: l("Año y mes", "Year and month"), text: l("Según la fecha de arribo.", "Based on the arrival date.") },
              { id: "filters", icon: "filter", tone: "cyan", term: l("Filtros", "Filters"), text: l("Los filtros de cada página aplican a todos sus componentes.", "The filters of each page apply to all of its components.") },
            ],
          }, {}, { x: 8, y: 8, w: 4, h: 12 }, { w: 12, h: 10 }),
        ];
      },
    }),

    // 2 · Port — Imports by Port
    panel({
      subcategory: { name: l("Port"), slug: "port", icon: "anchor" },
      panel: { name: l("Imports by Port"), slug: "port", icon: "anchor", audienceType: "ALL_MEMBERS" },
      filters: [text("poa"), when("date"), text("carrier")],
      bindings: ({ f, containers, teus }) => [
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "teus_total", query: agg({ measures: [teus], compareBy: f.date }) },
        { name: "consignees", query: agg({ groupBy: [f.consignee], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.consignee] }) },
        { name: "origins", query: agg({ groupBy: [f.country], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200 }) },
        { name: "carriers", query: agg({ groupBy: [f.carrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        { name: "entry_ports", query: agg({ groupBy: [f.poa], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        { name: "monthly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "MONTH_OF_YEAR" }, measures: yearMeasures(f, containers), orderBy: [{ key: f.date, direction: "ASC" }], limit: 12 }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Imports by Port", l("Imports by Port")),
        filterBar(),
        item("table", "data_grid", dataGrid("Containers by Consignee", [col("rank", "#", "rank", 48), col(f.consignee, "Consignee", "text", 200), col("containers", "Containers", "number", 100)], { search: true, exportable: false }), { data: binding("consignees") }, { x: 0, y: 4, w: 3, h: 20 }, { h: 14 }),
        item("map", "geo_map", { title: l("Containers by Country of Origin"), regionKey: f.country, valueKey: "containers", valueLabel: l("Contenedores", "Containers") }, { data: binding("origins") }, { x: 3, y: 4, w: 5, h: 20 }, { h: 12 }),
        kpi("kpi-containers", "Containers", "containers", "container", "blue", binding("containers_total"), { x: 8, y: 4, w: 2, h: 3 }),
        kpi("kpi-teus", "Teus", "teus", "container", "violet", binding("teus_total"), { x: 10, y: 4, w: 2, h: 3 }),
        item("carriers", "donut_chart", donutProps("Containers by Line/Agency", f.carrier), { data: binding("carriers"), total: binding("containers_total") }, { x: 8, y: 7, w: 4, h: 8 }, { h: 9 }),
        item("entry", "donut_chart", donutProps("Containers by Entry Port", f.poa), { data: binding("entry_ports"), total: binding("containers_total") }, { x: 8, y: 15, w: 4, h: 9 }, { h: 9 }),
        item("monthly", "line_chart", yearLines("Containers by month", f.date), { data: binding("monthly") }, { x: 0, y: 24, w: 12, h: 10 }, { h: 9 }),
      ],
    }),

    // 3 · Year Comparison — only containers with an origin country
    panel({
      subcategory: { name: l("Year Comparison"), slug: "year-comparison", icon: "calendar" },
      panel: { name: l("Imports by Year - Only containers with origin country"), slug: "year-comparison", icon: "calendar", audienceType: "ALL_MEMBERS" },
      filters: [text("poa"), text("consignee"), text("carrier"), when("date")],
      // Page filter: only rows that have a country of origin.
      pageFilters: ({ f }) => [{ fieldId: f.country, operator: "NE", value: null }],
      bindings: ({ f, containers }) => [
        { name: "yearly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "YEAR" }, measures: [containers], orderBy: [{ key: f.date, direction: "ASC" }], limit: 10 }) },
        { name: "ports_year", query: agg({ groupBy: [f.date], granularity: { [f.date]: "YEAR" }, measures: MAIN_PORTS.map(([key, name]) => measure("COUNT", null, `port_${key}`, { when: [{ fieldId: f.poa, operator: "EQ", value: name }] })), orderBy: [{ key: f.date, direction: "ASC" }], limit: 10 }) },
        { name: "monthly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "MONTH_OF_YEAR" }, measures: yearMeasures(f, containers), orderBy: [{ key: f.date, direction: "ASC" }], limit: 12 }) },
        { name: "regions", query: agg({ groupBy: [f.country], measures: [...yearMeasures(f, containers), measure("COUNT", null, "total")], orderBy: [{ key: "total", direction: "DESC" }], limit: 10 }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Imports by Year - Only containers with origin country", l("Imports by Year - Only containers with origin country")),
        filterBar(),
        item("ports", "bar_chart", { title: l("Containers by Year"), categoryKey: f.date, categoryFormat: "year", series: MAIN_PORTS.map(([key, name], index) => ({ key: `port_${key}`, label: l(name, name), color: PORT_COLORS[index] })), horizontal: false, variant: "grouped", showValues: true, height: 260 }, { data: binding("ports_year") }, { x: 0, y: 4, w: 8, h: 10 }, { h: 10 }),
        item("yearly", "bar_chart", { title: l("Containers by Year"), categoryKey: f.date, categoryFormat: "year", series: [{ key: "containers", label: l("Contenedores", "Containers"), color: BLUE }], horizontal: false, showValues: true, height: 260 }, { data: binding("yearly") }, { x: 8, y: 4, w: 4, h: 10 }, { h: 9 }),
        item("monthly", "line_chart", yearLines("Containers by Month and Year", f.date), { data: binding("monthly") }, { x: 0, y: 14, w: 7, h: 12 }, { h: 10 }),
        item("regions", "bar_chart", { title: l("Containers by Region and Year"), categoryKey: f.country, series: YEARS.map((year) => ({ key: `y${year}`, label: l(String(year), String(year)), color: YEAR_COLORS[year] })), horizontal: true, variant: "grouped", showValues: true, height: 300 }, { data: binding("regions") }, { x: 7, y: 14, w: 5, h: 12 }, { h: 12 }),
      ],
    }),

    // 4 · Consignee Details
    panel({
      subcategory: { name: l("Consignee Details"), slug: "consignee-details", icon: "users" },
      panel: { name: l("Consignee Details"), slug: "consignee-details", icon: "users", audienceType: "ALL_MEMBERS" },
      filters: [text("consignee"), when("date"), text("country"), text("pod")],
      bindings: ({ f, containers, teus }) => [
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "teus_total", query: agg({ measures: [teus], compareBy: f.date }) },
        { name: "entry_ports", query: agg({ groupBy: [f.poa], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 12 }) },
        { name: "carriers", query: agg({ groupBy: [f.carrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        { name: "monthly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], orderBy: [{ key: f.date, direction: "ASC" }], limit: 240 }) },
        { name: "origins", query: agg({ groupBy: [f.country], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200 }) },
        { name: "origin_table", query: agg({ groupBy: [f.country], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.country] }) },
        { name: "departure_table", query: agg({ groupBy: [f.pod], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.pod] }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Consignee Details", l("Consignee Details")),
        filterBar(),
        item("entry", "bar_chart", { title: l("Containers by Entry Port"), categoryKey: f.poa, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: BLUE }], horizontal: false, showValues: true, height: 240 }, { data: binding("entry_ports") }, { x: 0, y: 4, w: 4, h: 10 }, { h: 9 }),
        item("carriers", "donut_chart", donutProps("Containers by Line/Agency", f.carrier), { data: binding("carriers"), total: binding("containers_total") }, { x: 4, y: 4, w: 4, h: 10 }, { h: 9 }),
        kpi("kpi-containers", "Containers", "containers", "container", "blue", binding("containers_total"), { x: 8, y: 4, w: 2, h: 3 }),
        kpi("kpi-teus", "Teus", "teus", "container", "violet", binding("teus_total"), { x: 10, y: 4, w: 2, h: 3 }),
        item("monthly", "line_chart", { title: l("Containers by Month"), categoryKey: f.date, categoryFormat: "month", series: [{ key: "containers", label: l("Contenedores", "Containers"), color: BLUE }], variant: "line", height: 200 }, { data: binding("monthly") }, { x: 8, y: 7, w: 4, h: 7 }, { h: 8 }),
        item("map", "geo_map", { title: l("Containers by Country of Origin"), regionKey: f.country, valueKey: "containers", valueLabel: l("Contenedores", "Containers"), tone: "blue" }, { data: binding("origins") }, { x: 0, y: 14, w: 6, h: 16 }, { h: 12 }),
        item("origin-table", "data_grid", dataGrid("Containers by Origin", [col("rank", "#", "rank", 48), col(f.country, "Country of Origin", "text", 190), col("containers", "Containers", "number", 100)], { search: true, exportable: false, pageSizes: [10, 20] }), { data: binding("origin_table") }, { x: 6, y: 14, w: 6, h: 8 }, { h: 10 }),
        item("departure-table", "data_grid", dataGrid("Port of Departure", [col("rank", "#", "rank", 48), col(f.pod, "Port of Departure", "text", 220), col("containers", "Containers", "number", 100)], { search: true, exportable: false, pageSizes: [10, 20] }), { data: binding("departure_table") }, { x: 6, y: 22, w: 6, h: 8 }, { h: 10 }),
      ],
    }),

    // 5 · Consignees by Port — pivot: consignee x year
    panel({
      subcategory: { name: l("Consignees by Port"), slug: "consignees-by-port", icon: "buildings" },
      panel: { name: l("Consignees by Port - Year Comparison"), slug: "consignees-by-port", icon: "buildings", audienceType: "ALL_MEMBERS" },
      filters: [text("poa"), text("consignee"), when("date")],
      bindings: ({ f, containers }) => [
        { name: "pivot", query: agg({ groupBy: [f.consignee], measures: [...yearMeasures(f, containers), measure("COUNT", null, "total")], orderBy: [{ key: "total", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.consignee] }) },
        { name: "pivot_total", query: agg({ measures: [...yearMeasures(f, containers), measure("COUNT", null, "total")] }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Consignees by Port - Year Comparison", l("Consignees by Port - Year Comparison")),
        filterBar(),
        item("pivot", "data_grid", {
          ...dataGrid("Containers by Consignee", [
            col(f.consignee, "Consignee", "text", 300),
            ...YEARS.map((year) => col(`y${year}`, String(year), "number", 110, { zeroDash: true, align: "right" })),
            col("total", "Total", "number", 110, { align: "right" }),
          ], { search: true, defaultSort: { key: "total", direction: "DESC" }, pageSizes: [20, 50, 100], defaultPageSize: 50 }),
          totals: { binding: "totals", label: l("Grand total") },
        }, { data: binding("pivot"), totals: binding("pivot_total") }, { x: 0, y: 4, w: 12, h: 30 }, { h: 24 }),
      ],
    }),

    // 6 · Origin port Detail
    panel({
      subcategory: { name: l("Origin port Detail"), slug: "origin-port-detail", icon: "pin" },
      panel: { name: l("Origin port Detail"), slug: "origin-port-detail", icon: "pin", audienceType: "ALL_MEMBERS" },
      filters: [text("country"), text("pod"), when("date"), text("carrier")],
      bindings: ({ f, containers }) => [
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "departure_top", query: agg({ groupBy: [f.pod], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
        { name: "departure_table", query: agg({ groupBy: [f.pod], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.pod] }) },
        { name: "consignee_table", query: agg({ groupBy: [f.consignee], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.consignee] }) },
        { name: "grand_total", query: agg({ measures: [containers] }) },
        { name: "entry_ports", query: agg({ groupBy: [f.poa], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        { name: "carriers", query: agg({ groupBy: [f.carrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Origin port Detail", l("Origin port Detail")),
        filterBar(),
        item("top", "bar_chart", { title: l("Containers by Port of Departure"), categoryKey: f.pod, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: BLUE }], horizontal: true, showValues: true, height: 260 }, { data: binding("departure_top") }, { x: 0, y: 4, w: 4, h: 10 }, { h: 10 }),
        item("departure", "data_grid", { ...dataGrid("Port of Departure", [col("rank", "#", "rank", 48), col(f.pod, "Port of Departure", "text", 200), col("containers", "Containers", "number", 100)], { search: true, exportable: false }), totals: { binding: "totals", label: l("Grand total") } }, { data: binding("departure_table"), totals: binding("grand_total") }, { x: 0, y: 14, w: 4, h: 12 }, { h: 12 }),
        item("consignees", "data_grid", { ...dataGrid("Containers by Consignee", [col("rank", "#", "rank", 48), col(f.consignee, "Consignee", "text", 220), col("containers", "Containers", "number", 100)], { search: true, exportable: false }), totals: { binding: "totals", label: l("Grand total") } }, { data: binding("consignee_table"), totals: binding("grand_total") }, { x: 4, y: 4, w: 4, h: 22 }, { h: 16 }),
        kpi("kpi-containers", "Containers", "containers", "container", "blue", binding("containers_total"), { x: 8, y: 4, w: 4, h: 3 }),
        item("entry", "donut_chart", donutProps("Share by Entry Port", f.poa), { data: binding("entry_ports"), total: binding("containers_total") }, { x: 8, y: 7, w: 4, h: 9 }, { h: 9 }),
        item("carriers", "donut_chart", donutProps("Share by Line/Agency", f.carrier), { data: binding("carriers"), total: binding("containers_total") }, { x: 8, y: 16, w: 4, h: 10 }, { h: 9 }),
      ],
    }),

    // 7 · Table Consignees List
    panel({
      subcategory: { name: l("Table Consignees List"), slug: "table-consignees-list", icon: "list" },
      panel: { name: l("Table Consignee List"), slug: "consignees-list", icon: "list", audienceType: "ALL_MEMBERS" },
      filters: [text("consignee"), when("date"), text("poa")],
      bindings: ({ f, containers, teus }) => [
        { name: "results", query: agg({
          groupBy: [f.date, f.consignee, f.country, f.pod, f.poa], granularity: { [f.date]: "MONTH" },
          measures: [measure("MIN", f.date, "year_ref"), containers, teus],
          orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.consignee, f.country, f.pod, f.poa],
        }) },
        { name: "grand_total", query: agg({ measures: [containers, teus] }) },
      ],
      items: ({ f, binding }) => [
        titleBar("Table Consignee List", l("Table Consignee List")),
        filterBar(),
        item("table", "data_grid", {
          ...dataGrid("Table Consignee List", [
            col("year_ref", "Year", "year", 70), col(f.date, "Month", "month", 90), col(f.consignee, "Consignee", "text", 240), col(f.country, "Country of Origin", "text", 150),
            col(f.pod, "Port of Departure", "text", 200), col(f.poa, "Port of Arrival", "text", 200), col("containers", "Containers", "number", 100), col("teus", "Teus", "decimal", 90),
          ], { search: true, defaultSort: { key: "containers", direction: "DESC" }, pageSizes: [20, 50, 100, 200], defaultPageSize: 50 }),
          totals: { binding: "totals", label: l("Grand total") },
        }, { data: binding("results"), totals: binding("grand_total") }, { x: 0, y: 4, w: 12, h: 30 }, { h: 24 }),
      ],
    }),
  ],
};

// ─── builders ───────────────────────────────────────────────────────────────────────────────────────────

/** Containers of each year next to each other in the same row (conditional measures over the arrival date). */
function yearMeasures(f, containers) {
  void containers;
  return YEARS.map((year) => measure("COUNT", null, `y${year}`, { when: [{ fieldId: f.date, operator: "GTE", value: `${year}-01-01` }, { fieldId: f.date, operator: "LTE", value: `${year}-12-31` }] }));
}
const yearLines = (title, dateKey) => ({ title: l(title), categoryKey: dateKey, categoryFormat: "monthOfYear", series: [2025, 2024, 2026].map((year) => ({ key: `y${year}`, label: l(String(year), String(year)), color: YEAR_COLORS[year] })), variant: "line", height: 240 });
const donutProps = (title, categoryKey) => ({ title: l(title), categoryKey, valueKey: "containers", maxSlices: 5, totalKey: "containers", height: 240, variant: "donut", showTotal: true, centerLabel: l("Contenedores", "Containers"), legend: "right" });

function panel(spec) {
  const keys = {
    date: "arrival_date", container: "container_number", consignee: "consignee", carrier: "carrier", poa: "port_of_arrival", pod: "port_of_departure",
    country: "country_of_origin", teusField: "teus", bl: "bill_of_lading_nbr",
  };
  const fieldsOf = (fieldId) => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, fieldId(key)]));
  return {
    subcategory: spec.subcategory,
    panel: spec.panel,
    bindings: ({ fieldId }) => {
      const f = fieldsOf(fieldId);
      const containers = measure("COUNT", null, "containers");
      const teus = measure("SUM", f.teusField, "teus", { distinctBy: f.bl });
      // The same allowlist on every binding keeps the filter bar, counts and every component consistent.
      const allowed = spec.filters.map((entry) => ({ fieldId: f[entry.key], operators: entry.operators }));
      const page = spec.pageFilters ? spec.pageFilters({ f }) : [];
      return spec.bindings({ f, containers, teus }).map((binding) => ({
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
  arrival_date: l("Month / Year"), port_of_arrival: l("Port of Arrival"), carrier: l("Carrier"), consignee: l("Consignee"),
  country_of_origin: l("Country of Origin"), port_of_departure: l("Port of Departure"),
};
const filterBar = () => item("filters", "filter_bar", { title: l("Filtros", "Filters"), labels: FILTER_LABELS }, {}, { x: 0, y: 2, w: 12, h: 2 }, { h: 4 }, { h: 4 });
const kpi = (id, label, valueKey, icon, tone, data, desktop) => item(id, "kpi_card", { label: l(label), valueKey, format: "number", icon, tone, variant: "compact" }, { data }, desktop, { w: 6, h: 3 }, { w: 6, h: 3 });

const col = (key, label, kind, width, extra = {}) => ({ key, label: l(label), kind, sortable: kind !== "rank", width, ...extra });
function dataGrid(title, columns, options = {}) {
  const { search = true, exportable = true, defaultSort = { key: "containers", direction: "DESC" }, pageSizes = [10, 20, 30], defaultPageSize = 20 } = options;
  return { title: l(title), columns, pageSizes, defaultPageSize, defaultSort, searchable: search, selectable: false, exportable };
}
