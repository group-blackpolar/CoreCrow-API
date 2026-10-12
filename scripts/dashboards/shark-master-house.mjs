// SHARK · Master House report: the eight panels of the Looker Studio reference, provisioned into the EXISTING
// category `master-house` (matched by slug; nothing is duplicated). Everything SHARK-specific lives here (dataset keys,
// queries, copy, layout); the components, renderer and runner are the generic NORTH dashboard engine.
//
//   node scripts/provision-view.mjs scripts/dashboards/shark-master-house.mjs --org shark [--only <panel-slug>] [--publish]
//
// Metric rules (audited against the source workbook; see docs/master-house-metrics.md):
//   containers   COUNT_DISTINCT container_number          a container can appear in several Master/House rows
//   weight (MT)  SUM house_weight_mt / master_weight_mt   per-container allocation of the BL weight, so it sums safely
//   TEUs         SUM master_teus / house_teus DISTINCT BY the BL number: the TEU value belongs to the BL and is repeated on
//                every container row of that BL (a plain SUM overstates Master TEUs by ~29%)
//   metric tons  SUM house_metric_tons DISTINCT BY house BL (BL-level value repeated per container)
//   Master side (03, 05, 07 country, 08) vs House side (02, 04, 06) follows the title of each panel; Master and House
//   country of origin differ on ~16% of rows, so they are never mixed inside one panel.
const l = (es, en = es) => ({ es, en });
const measure = (operation, fieldId, alias, extra = {}) => ({ operation, ...(fieldId ? { fieldId } : {}), ...extra, alias });
const agg = (spec) => ({ mode: "AGGREGATE", ...spec });
const TEXT_OPS = ["IN", "EQ"];
const DATE_OPS = ["GTE", "LTE"];

const BLUE = "#2F6FED"; const VIOLET = "#7C5CFC"; const GREEN = "#1F9D63";
const ROW_HEIGHT = 16; // minimum row height in px; `fit` stretches the rows to the viewport

const text = (key) => ({ key, operators: TEXT_OPS });
const when = (key) => ({ key, operators: DATE_OPS });

export default {
  datasetSlug: "master-house-2024-2026",
  category: { name: l("Master House"), slug: "master-house", icon: "ship", color: "#2F6FED" },

  panels: [
    // ---------------------------------------------------------------------------------------------------------------
    // 01 · Dashboard Information
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Dashboard Information"), slug: "dashboard-information", icon: "info" },
      panel: { name: l("Dashboard Information"), slug: "overview", icon: "info", audienceType: "ALL_MEMBERS" },
      filters: [],
      bindings: ({ f, containers }) => [
        // One row; every KPI of the coverage card reads a column of it. Nothing here is typed by hand.
        { name: "coverage", query: agg({ measures: [
          measure("MIN", f.date, "first_date"), measure("MAX", f.date, "last_date"), containers,
          measure("COUNT_DISTINCT", f.masterBl, "master_bls"), measure("COUNT_DISTINCT", f.houseBl, "house_bls"),
          measure("COUNT_DISTINCT", f.masterConsignee, "master_consignees"), measure("COUNT_DISTINCT", f.houseConsignee, "house_consignees"),
          measure("SUM", f.houseWeight, "weight_mt"),
        ] }) },
      ],
      items: ({ binding }) => {
        const kpi = (id, x, key, label, format, icon, tone, extra = {}) => item(id, "kpi_card", { label, valueKey: key, format, icon, tone, variant: "compact", ...extra }, { data: binding("coverage") }, { x, y: 5, w: 2, h: 3 }, { w: 6, h: 3 });
        const card = (id, panelSlug, icon, tone, title, description) => ({ id, panelSlug, icon, tone, title: l(title), description });
        return [
          // Everything numeric below is a bound KPI of the `coverage` binding (computed from the data); the rest is static copy.
          item("hero", "hero", {
            eyebrow: l("REPORTE DE IMPORTACIONES", "IMPORTS REPORT"), title: l("IMPORTS MASTER-HOUSE"),
            body: l("Reporte de operaciones de importación de Master BL, House BL, consignatarios, contenedores y toneladas métricas. Cada categoría cruza la carga con su consignatario, país de origen, puertos y línea naviera a partir de los registros importados.",
              "Import operations report for Master BL, House BL, consignees, containers and metric tons. Each page crosses the cargo with its consignee, country of origin, ports and shipping line from the imported records."),
            chips: [{ icon: "filter", label: l("Datos de importación", "Import data") }, { icon: "calendar", label: l("Cobertura histórica y actual", "Historical and current coverage") }],
            aside: { icon: "bars", title: l("Análisis integral de la cadena de importación", "End-to-end import chain analysis"), body: l("De los registros a la visualización, para una toma de decisiones más rápida.", "From records to visualization, for faster decisions.") },
            showBrand: true,
          }, {}, { x: 0, y: 0, w: 12, h: 5 }, { w: 12, h: 8 }),
          kpi("kpi-from", 0, "first_date", l("Primer registro", "First record"), "date", "calendar", "blue", { subtitle: { mode: "text", text: l("Inicio de la cobertura", "Start of coverage") } }),
          kpi("kpi-to", 2, "last_date", l("Último registro", "Latest record"), "date", "clock", "slate", { subtitle: { mode: "relative_date" } }),
          kpi("kpi-containers", 4, "containers", l("Contenedores únicos", "Unique containers"), "number", "container", "blue"),
          kpi("kpi-master", 6, "master_bls", l("Master BL", "Master BLs"), "number", "package", "violet"),
          kpi("kpi-house", 8, "house_bls", l("House BL", "House BLs"), "number", "package", "cyan"),
          kpi("kpi-weight", 10, "weight_mt", l("Peso House (MT)", "House weight (MT)"), "decimal", "scale", "green", { decimals: 0 }),
          item("nav", "link_cards", {
            title: l("¿Qué incluye este reporte?", "What does this report include?"), icon: "book",
            items: [
              card("search-by", "master-house-consignee", "filter", "cyan", "Search By", l("Búsqueda por Master o House Consignee, puertos y país de origen.", "Look up by Master or House Consignee, ports and country of origin.")),
              card("master", "master-consignees", "list", "blue", "Master Consignee List", l("Contenedores, TEUs y peso por consignatario Master.", "Containers, TEUs and weight by Master consignee.")),
              card("house", "house-consignees", "package", "violet", "House Consignee List", l("Contenedores y peso House por consignatario, con evolución mensual.", "Containers and House weight by consignee, with monthly evolution.")),
              card("port", "port-of-departure", "anchor", "amber", "Search by Port of Departure", l("Rutas puerto de salida → puerto de arribo.", "Departure → arrival port routes.")),
              card("cargo", "consignees-cargo", "users", "green", "Consignees and Cargo Table", l("Tabla detallada por mes, transportista y puerto.", "Detailed table by month, carrier and port.")),
              card("table", "consignees", "ship", "slate", "Consignees Table", l("Relación directa Master ↔ House.", "Direct Master ↔ House relation.")),
              card("ff", "top-freight-forwarders", "bars", "rose", "Top Freight Forwarders", l("Ranking de forwarders por contenedores o TEUs.", "Forwarder ranking by containers or TEUs.")),
            ],
          }, {}, { x: 0, y: 8, w: 8, h: 10 }, { w: 12, h: 14 }),
          item("units", "definition_list", {
            title: l("Unidades y definiciones", "Units and definitions"), icon: "info",
            items: [
              { id: "containers", icon: "container", tone: "blue", term: l("Contenedores", "Containers"), text: l("Números de contenedor únicos.", "Unique container numbers.") },
              { id: "teus", icon: "container", tone: "cyan", term: l("TEUs", "TEUs"), text: l("Se cuentan una vez por Master/House BL.", "Counted once per Master/House BL.") },
              { id: "master", icon: "package", tone: "violet", term: l("Master BL", "Master BL"), text: l("Conocimiento de embarque principal.", "Main bill of lading.") },
              { id: "house", icon: "package", tone: "cyan", term: l("House BL", "House BL"), text: l("Conocimiento de embarque secundario.", "Secondary bill of lading.") },
              { id: "weight", icon: "scale", tone: "green", term: l("Peso (MT)", "Weight (MT)"), text: l("Toneladas métricas asignadas por contenedor.", "Metric tons allocated per container.") },
              { id: "coverage", icon: "calendar", tone: "slate", term: l("Cobertura", "Coverage"), text: l("Se calcula de los registros importados.", "Computed from the imported records.") },
            ],
          }, {}, { x: 8, y: 8, w: 4, h: 10 }, { w: 12, h: 10 }),
        ];
      },
      // No filter bar on the information page.
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 02 · Search By
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Search By"), slug: "search-by", icon: "magnifying-glass" },
      panel: { name: l("Search By"), slug: "master-house-consignee", icon: "magnifying-glass", audienceType: "ALL_MEMBERS" },
      filters: [text("masterConsignee"), text("houseConsignee"), text("housePortOfArrival"), text("housePortOfDeparture"), when("date"), text("houseCountry")],
      bindings: ({ f, containers }) => {
        const houseWeight = measure("SUM", f.houseWeight, "weight_mt");
        return [
          { name: "results", query: agg({ groupBy: [f.masterConsignee, f.houseConsignee], measures: [containers, houseWeight], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.masterConsignee, f.houseConsignee] }) },
          { name: "results_trend", noDate: true, query: agg({ groupBy: [f.masterConsignee, f.houseConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
          { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
          { name: "countries", query: agg({ groupBy: [f.houseCountry], measures: [houseWeight, containers], orderBy: [{ key: "weight_mt", direction: "DESC" }], limit: 200 }) },
          { name: "origin", query: agg({ groupBy: [f.houseCountry], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "origin_ports", query: agg({ groupBy: [f.housePortOfDeparture], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "carriers", query: agg({ groupBy: [f.houseCarrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        ];
      },
      items: ({ f, binding }) => standardBody(f, binding, {
        table: { props: dataGrid("Containers and Weight (MT) by Master and House Consignee", [
          col(f.masterConsignee, "Master Consignee", "text", 150), col(f.houseConsignee, "House Consignee", "text", 150),
          col("containers", "Containers", "bar", 112), col("weight_mt", "Weight MT", "decimal", 92), trendCol(), actionsCol(),
        ], { trend: { binding: "trend", rowKeys: [f.masterConsignee, f.houseConsignee], categoryKey: f.date, valueKey: "containers" } }), bindings: { data: binding("results"), trend: binding("results_trend") } },
        map: geoMap("Weight per Origin Country (MT)", f.houseCountry, "weight_mt", "containers", binding("countries")),
        bars: originBars("Containers per Origin - BL", f.houseCountry, f.housePortOfDeparture, "Puertos de salida", binding("origin"), binding("origin_ports")),
        donut: carrierDonut("Volume per Shipping Line/Agency (Containers)", f.houseCarrier, binding("carriers"), binding("containers_total")),
        layout: "right-stack",
      }),
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 03 · Master Consignee List
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Master Consignee List"), slug: "master-consignee-list", icon: "users-three" },
      panel: { name: l("Master Consignee List"), slug: "master-consignees", icon: "users-three", audienceType: "ALL_MEMBERS" },
      filters: [text("masterConsignee"), text("masterPortOfArrival"), text("masterCarrier"), when("date"), text("masterCountry"), text("masterPortOfDeparture")],
      bindings: ({ f, containers, masterTeus }) => {
        const weight = measure("SUM", f.masterWeight, "weight_mt");
        return [
          { name: "results", query: agg({ groupBy: [f.masterConsignee], measures: [containers, masterTeus, weight], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.masterConsignee] }) },
          { name: "results_trend", noDate: true, query: agg({ groupBy: [f.masterConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
          { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
          { name: "countries", query: agg({ groupBy: [f.masterCountry], measures: [weight, containers], orderBy: [{ key: "weight_mt", direction: "DESC" }], limit: 200 }) },
          { name: "origin", query: agg({ groupBy: [f.masterCountry], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "origin_ports", query: agg({ groupBy: [f.masterPortOfDeparture], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "carriers", query: agg({ groupBy: [f.masterCarrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        ];
      },
      items: ({ f, binding }) => standardBody(f, binding, {
        // The reference captured a table titled "...and Weight (MT)" whose columns had no weight; both are shown here.
        table: { props: dataGrid("Containers, TEUs and Weight (MT) by Master Consignee", [
          col(f.masterConsignee, "Master Consignee", "text", 190), col("containers", "Containers", "bar", 112),
          col("master_teus", "Master TEUs", "number", 90), col("weight_mt", "Master Weight (MT)", "decimal", 110), trendCol(), actionsCol(),
        ], { trend: { binding: "trend", rowKeys: [f.masterConsignee], categoryKey: f.date, valueKey: "containers" } }), bindings: { data: binding("results"), trend: binding("results_trend") } },
        map: geoMap("Weight per Origin Country (MT)", f.masterCountry, "weight_mt", "containers", binding("countries")),
        bars: originBars("Containers per Origin - Master BL", f.masterCountry, f.masterPortOfDeparture, "Puertos de salida", binding("origin"), binding("origin_ports")),
        donut: carrierDonut("Volume per Shipping Line/Agency (Containers)", f.masterCarrier, binding("carriers"), binding("containers_total")),
        layout: "right-stack",
      }),
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 04 · House Consignee List
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("House Consignee List"), slug: "house-consignee-list", icon: "buildings" },
      panel: { name: l("House Consignee List"), slug: "house-consignees", icon: "buildings", audienceType: "ALL_MEMBERS" },
      filters: [text("houseConsignee"), text("housePortOfArrival"), text("houseCarrier"), when("date"), text("houseCountry"), text("housePortOfDeparture")],
      bindings: ({ f, containers }) => {
        const weight = measure("SUM", f.houseWeight, "weight_mt");
        return [
          { name: "results", query: agg({ groupBy: [f.houseConsignee], measures: [containers, weight], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.houseConsignee] }) },
          { name: "results_trend", noDate: true, query: agg({ groupBy: [f.houseConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
          { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
          // A real calendar axis: one bucket per month, oldest first (never alphabetical, years never mixed).
          { name: "weight_monthly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "MONTH" }, measures: [weight], orderBy: [{ key: f.date, direction: "ASC" }], limit: 240 }) },
          { name: "origin", query: agg({ groupBy: [f.houseCountry], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "origin_ports", query: agg({ groupBy: [f.housePortOfDeparture], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
          { name: "carriers", query: agg({ groupBy: [f.houseCarrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        ];
      },
      items: ({ f, binding }) => {
        const T = { w: 12 };
        return [
          filterBar({ house_port_of_arrival: l("House Port of Arrival"), house_port_of_departure: l("Port of Departure") }),
          item("table", "data_grid", dataGrid("Containers and Weight (MT) by House Consignee", [
            col(f.houseConsignee, "House Consignee", "text", 260), col("containers", "Containers", "bar", 120), col("weight_mt", "House Weight (MT)", "decimal", 130), trendCol(), actionsCol(),
          ], { trend: { binding: "trend", rowKeys: [f.houseConsignee], categoryKey: f.date, valueKey: "containers" }, search: true }), { data: binding("results"), trend: binding("results_trend") }, { x: 0, y: 3, w: 6, h: 15 }, { ...T, h: 14 }),
          item("monthly", "line_chart", { title: l("Weight per Month (MT)"), categoryKey: f.date, categoryFormat: "month", series: [{ key: "weight_mt", label: l("Peso (MT)", "Weight (MT)"), color: BLUE }], variant: "area", height: 240 }, { data: binding("weight_monthly") }, { x: 6, y: 3, w: 6, h: 6 }, { ...T, h: 8 }),
          item("origin", "bar_chart", originBarProps("Containers per Origin - House BL", f.houseCountry, f.housePortOfDeparture, "Puertos de salida"), { data: binding("origin"), drill: binding("origin_ports") }, { x: 6, y: 9, w: 3, h: 9 }, { ...T, h: 8 }),
          item("carriers", "donut_chart", carrierDonutProps("Volume per Shipping Line/Agency (Containers)", f.houseCarrier), { data: binding("carriers"), total: binding("containers_total") }, { x: 9, y: 9, w: 3, h: 9 }, { ...T, h: 8 }),
        ];
      },
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 05 · Search by Port of Departure
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Search by Port of Departure"), slug: "search-by-port-of-departure", icon: "anchor" },
      panel: { name: l("Search by Port of Departure"), slug: "port-of-departure", icon: "anchor", audienceType: "ALL_MEMBERS" },
      // The reference listed the Port of ARRIVAL while the page is named after the port of DEPARTURE: both filters are offered
      // and the table carries both ports, so the dimension of every column matches its header.
      filters: [text("masterConsignee"), text("masterBillType"), when("date"), text("masterPortOfArrival"), text("masterBl"), text("masterPortOfDeparture")],
      bindings: ({ f, containers, masterTeus }) => [
        { name: "teus_total", query: agg({ measures: [masterTeus], compareBy: f.date }) },
        { name: "results", query: agg({ groupBy: [f.masterConsignee, f.masterPortOfDeparture, f.masterPortOfArrival], measures: [containers, masterTeus], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.masterConsignee, f.masterPortOfDeparture, f.masterPortOfArrival] }) },
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "origin", query: agg({ groupBy: [f.masterCountry], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
        { name: "origin_ports", query: agg({ groupBy: [f.masterPortOfDeparture], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
        { name: "consignees", query: agg({ groupBy: [f.masterConsignee], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
        { name: "yearly", query: agg({ groupBy: [f.date], granularity: { [f.date]: "YEAR" }, measures: [containers], orderBy: [{ key: f.date, direction: "ASC" }], limit: 50 }) },
        { name: "carriers", query: agg({ groupBy: [f.masterCarrier], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
        { name: "entry_ports", query: agg({ groupBy: [f.masterPortOfArrival], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 30 }) },
      ],
      items: ({ f, binding }) => [
        filterBar({ master_bill_of_lading_nbr: l("Master Bill of Lading Number") }),
        item("kpi-teus", "kpi_card", { label: l("Master TEUs"), valueKey: "master_teus", format: "number", icon: "container", tone: "violet", variant: "trend", comparison: {}, tooltip: l("TEUs contados una vez por Master BL", "TEUs counted once per Master BL") }, { data: binding("teus_total") }, { x: 0, y: 3, w: 5, h: 3 }, { h: 2 }),
        item("table", "data_grid", dataGrid("Consignees and ports", [
          col(f.masterConsignee, "Master Consignee", "text", 200), col(f.masterPortOfDeparture, "Port of Departure", "text", 150), col(f.masterPortOfArrival, "Master Port of Arrival", "text", 160),
          col("containers", "Containers", "bar", 110), col("master_teus", "Master TEUs", "number", 100),
        ], { search: true, exportable: true }), { data: binding("results") }, { x: 0, y: 6, w: 5, h: 16 }, { h: 14 }),
        item("origin", "bar_chart", originBarProps("Containers per Origin", f.masterCountry, f.masterPortOfDeparture, "Puertos de salida"), { data: binding("origin"), drill: binding("origin_ports") }, { x: 5, y: 3, w: 4, h: 9 }, { h: 8 }),
        item("consignees", "bar_chart", barProps("Containers by Master Consignee", f.masterConsignee, GREEN), { data: binding("consignees") }, { x: 9, y: 3, w: 3, h: 9 }, { h: 8 }),
        item("yearly", "bar_chart", { ...barProps("Master Containers per Year", f.date, BLUE), horizontal: false, categoryFormat: "year" }, { data: binding("yearly") }, { x: 5, y: 12, w: 3, h: 10 }, { h: 8 }),
        item("carriers", "donut_chart", carrierDonutProps("Containers per Shipping Line/Agency", f.masterCarrier, "bottom"), { data: binding("carriers"), total: binding("containers_total") }, { x: 8, y: 12, w: 2, h: 10 }, { h: 8 }),
        item("entry", "donut_chart", carrierDonutProps("Containers per Entry Port", f.masterPortOfArrival, "bottom"), { data: binding("entry_ports"), total: binding("containers_total") }, { x: 10, y: 12, w: 2, h: 10 }, { h: 8 }),
      ],
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 06 · Consignees and Cargo Table
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Consignees and Cargo Table"), slug: "consignees-and-cargo-table", icon: "table" },
      panel: { name: l("Consignees and Cargo Table"), slug: "consignees-cargo", icon: "table", audienceType: "ALL_MEMBERS" },
      filters: [text("houseConsignee"), text("housePortOfDeparture"), text("houseCountry"), when("date")],
      bindings: ({ f, containers, houseTeus }) => [
        { name: "weight_total", query: agg({ measures: [measure("SUM", f.houseWeight, "weight_mt")], compareBy: f.date }) },
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "consignees_total", query: agg({ measures: [measure("COUNT_DISTINCT", f.houseConsignee, "house_consignees")], compareBy: f.date }) },
        { name: "results", query: agg({
          groupBy: [f.date, f.houseConsignee, f.houseCarrier, f.housePortOfDeparture, f.houseCountry], granularity: { [f.date]: "MONTH" },
          measures: [measure("MIN", f.date, "year_ref"), containers, measure("SUM", f.houseMetricTons, "house_metric_tons", { distinctBy: f.houseBl })],
          orderBy: [{ key: f.date, direction: "DESC" }, { key: "containers", direction: "DESC" }], limit: 200, includeTotal: true,
          searchFieldIds: [f.houseConsignee, f.houseCarrier, f.housePortOfDeparture, f.houseCountry],
        }) },
        { name: "results_trend", noDate: true, query: agg({ groupBy: [f.houseConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
      ],
      items: ({ f, binding }) => [
        filterBar({ house_port_of_departure: l("House Port of Departure") }),
        item("kpi-weight", "kpi_card", { label: l("House Weight (MT)"), valueKey: "weight_mt", format: "decimal", decimals: 0, icon: "scale", tone: "green", variant: "trend", comparison: {} }, { data: binding("weight_total") }, { x: 0, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("kpi-containers", "kpi_card", { label: l("Containers"), valueKey: "containers", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, { data: binding("containers_total") }, { x: 4, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("kpi-consignees", "kpi_card", { label: l("House Consignees"), valueKey: "house_consignees", format: "number", icon: "buildings", tone: "cyan", variant: "compact" }, { data: binding("consignees_total") }, { x: 8, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("table", "data_grid", dataGrid("Containers and Weight (MT) by House Consignee", [
          col("year_ref", "Year", "year", 70), col(f.date, "Month", "month", 90), col(f.houseConsignee, "House Consignee", "text", 230), col(f.houseCarrier, "House Carrier", "text", 170),
          col(f.housePortOfDeparture, "House Port of Departure", "text", 190), col(f.houseCountry, "Country of Origin", "text", 150), col("containers", "Containers", "number", 100),
          col("house_metric_tons", "House Metric Tons", "decimal", 130), trendCol(), actionsCol(),
        ], { trend: { binding: "trend", rowKeys: [f.houseConsignee], categoryKey: f.date, valueKey: "containers" }, search: true, defaultSort: { key: f.date, direction: "DESC" }, pageSizes: [20, 50, 100, 200], defaultPageSize: 50 }), { data: binding("results"), trend: binding("results_trend") }, { x: 0, y: 6, w: 12, h: 12 }, { h: 14 }),
      ],
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 07 · Consignees Table
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Consignees Table"), slug: "consignees-table", icon: "table" },
      panel: { name: l("Consignees Table"), slug: "consignees", icon: "table", audienceType: "ALL_MEMBERS" },
      filters: [text("masterConsignee"), text("houseConsignee"), text("masterCountry"), text("masterPortOfDeparture"), when("date")],
      bindings: ({ f, containers }) => {
        const weight = measure("SUM", f.houseWeight, "weight_mt");
        return [
          { name: "weight_total", query: agg({ measures: [weight], compareBy: f.date }) },
          { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
          { name: "consignees_total", query: agg({ measures: [measure("COUNT_DISTINCT", f.houseConsignee, "house_consignees")], compareBy: f.date }) },
          // Master -> House through the flat dataset: one row per container, so nothing is joined and nothing can double count.
          { name: "results", query: agg({
            groupBy: [f.date, f.masterConsignee, f.houseConsignee, f.houseCarrier, f.housePortOfDeparture], granularity: { [f.date]: "MONTH" },
            measures: [measure("MIN", f.date, "year_ref"), weight, containers],
            orderBy: [{ key: f.date, direction: "DESC" }, { key: "containers", direction: "DESC" }], limit: 200, includeTotal: true,
            searchFieldIds: [f.masterConsignee, f.houseConsignee, f.houseCarrier, f.housePortOfDeparture],
          }) },
          { name: "results_trend", noDate: true, query: agg({ groupBy: [f.masterConsignee, f.houseConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
        ];
      },
      items: ({ f, binding }) => [
        filterBar({ master_country_of_origin: l("Master Country of Origin") }),
        item("kpi-weight", "kpi_card", { label: l("House Weight (MT)"), valueKey: "weight_mt", format: "decimal", decimals: 0, icon: "scale", tone: "green", variant: "trend", comparison: {} }, { data: binding("weight_total") }, { x: 0, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("kpi-containers", "kpi_card", { label: l("Containers"), valueKey: "containers", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, { data: binding("containers_total") }, { x: 4, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("kpi-consignees", "kpi_card", { label: l("House Consignees"), valueKey: "house_consignees", format: "number", icon: "buildings", tone: "cyan", variant: "compact" }, { data: binding("consignees_total") }, { x: 8, y: 3, w: 4, h: 3 }, { h: 2 }),
        item("table", "data_grid", dataGrid("Containers and Weight (MT) by Master and House Consignee", [
          col("year_ref", "Year", "year", 70), col(f.date, "Month", "month", 90), col(f.masterConsignee, "Master Consignee", "text", 210), col(f.houseConsignee, "House Consignee", "text", 210),
          col(f.houseCarrier, "Carrier", "text", 160), col(f.housePortOfDeparture, "House Port of Departure", "text", 190), col("weight_mt", "Weight (MT)", "decimal", 110),
          col("containers", "Containers", "number", 100), trendCol(), actionsCol(),
        ], { trend: { binding: "trend", rowKeys: [f.masterConsignee, f.houseConsignee], categoryKey: f.date, valueKey: "containers" }, search: true, defaultSort: { key: f.date, direction: "DESC" }, pageSizes: [20, 50, 100, 200], defaultPageSize: 50 }), { data: binding("results"), trend: binding("results_trend") }, { x: 0, y: 6, w: 12, h: 12 }, { h: 14 }),
      ],
    }),

    // ---------------------------------------------------------------------------------------------------------------
    // 08 · Top Freight Forwarders
    // ---------------------------------------------------------------------------------------------------------------
    panel({
      subcategory: { name: l("Top Freight Forwarders"), slug: "top-freight-forwarders", icon: "truck" },
      panel: { name: l("Top Freight Forwarders"), slug: "top-freight-forwarders", icon: "truck", audienceType: "ALL_MEMBERS" },
      // Verified on the data: the largest Master Consignees are forwarders / consolidators (KUEHNE NAGEL, DHL, ASWW ...), while
      // the House Consignee is the cargo owner. The Master Consignee is therefore the Freight Forwarder of this ranking.
      filters: [text("masterConsignee"), when("date"), text("masterCountry")],
      bindings: ({ f, containers, masterTeus }) => [
        { name: "containers_total", query: agg({ measures: [containers], compareBy: f.date }) },
        { name: "teus_total", query: agg({ measures: [masterTeus], compareBy: f.date }) },
        { name: "forwarders_total", query: agg({ measures: [measure("COUNT_DISTINCT", f.masterConsignee, "forwarders")], compareBy: f.date }) },
        { name: "ranking", query: agg({ groupBy: [f.masterConsignee], measures: [containers, masterTeus], orderBy: [{ key: "containers", direction: "DESC" }], limit: 200, includeTotal: true, searchFieldIds: [f.masterConsignee] }) },
        { name: "results_trend", noDate: true, query: agg({ groupBy: [f.masterConsignee, f.date], granularity: { [f.date]: "MONTH" }, measures: [containers], limit: 1000 }) },
        { name: "top_bars", query: agg({ groupBy: [f.masterConsignee], measures: [containers], orderBy: [{ key: "containers", direction: "DESC" }], limit: 10 }) },
      ],
      items: ({ f, binding }) => [
        filterBar({ master_country_of_origin: l("Top Country") }),
        item("kpi-containers", "kpi_card", { label: l("Containers"), valueKey: "containers", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {} }, { data: binding("containers_total") }, { x: 0, y: 3, w: 3, h: 3 }, { h: 2 }),
        item("kpi-teus", "kpi_card", { label: l("Master TEUs"), valueKey: "master_teus", format: "number", icon: "container", tone: "violet", variant: "trend", comparison: {} }, { data: binding("teus_total") }, { x: 3, y: 3, w: 3, h: 3 }, { h: 2 }),
        item("kpi-ff", "kpi_card", { label: l("Freight forwarders", "Freight forwarders"), valueKey: "forwarders", format: "number", icon: "users", tone: "green", variant: "compact" }, { data: binding("forwarders_total") }, { x: 6, y: 3, w: 2, h: 3 }, { h: 2 }),
        item("table", "data_grid", dataGrid("Top Freight Forwarders for Imports (Master BL)", [
          col("rank", "#", "rank", 56), col(f.masterConsignee, "Master Consignee / Freight Forwarder", "text", 320),
          col("containers", "Containers", "number", 130, { heat: true }), col("master_teus", "Master TEUs", "number", 130, { heat: true }), trendCol(), actionsCol(),
        ], { trend: { binding: "trend", rowKeys: [f.masterConsignee], categoryKey: f.date, valueKey: "containers" }, search: true, pageSizes: [15, 25, 50, 100], defaultPageSize: 15 }), { data: binding("ranking"), trend: binding("results_trend") }, { x: 0, y: 6, w: 8, h: 12 }, { h: 14 }),
        item("top", "bar_chart", barProps("Containers per freight forwarder", f.masterConsignee, BLUE), { data: binding("top_bars") }, { x: 8, y: 3, w: 4, h: 15 }, { h: 9 }),
      ],
    }),
  ],
};

// ─── builders ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One panel entry for scripts/provision-view.mjs: fills in the shared field map, filter allowlists and the section. */
function panel(spec) {
  const keys = {
    date: "arrival_date", masterBl: "master_bill_of_lading_nbr", houseBl: "house_bill_of_lading_nbr", container: "container_number",
    masterConsignee: "master_consignee", houseConsignee: "house_consignee", masterCarrier: "master_carrier", houseCarrier: "house_carrier",
    masterPortOfArrival: "master_port_of_arrival", housePortOfArrival: "house_port_of_arrival", masterPortOfDeparture: "master_port_of_departure",
    housePortOfDeparture: "house_port_of_departure", masterCountry: "master_country_of_origin", houseCountry: "house_country_of_origin",
    masterBillType: "master_bill_type", masterTeusField: "master_teus", houseTeusField: "house_teus", masterWeight: "master_weight_mt",
    houseWeight: "house_weight_mt", houseMetricTons: "house_metric_tons",
  };
  return {
    subcategory: spec.subcategory,
    panel: spec.panel,
    bindings: ({ fieldId }) => {
      const f = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, fieldId(key)]));
      const containers = measure("COUNT_DISTINCT", f.container, "containers");
      const masterTeus = measure("SUM", f.masterTeusField, "master_teus", { distinctBy: f.masterBl });
      const houseTeus = measure("SUM", f.houseTeusField, "house_teus", { distinctBy: f.houseBl });
      // The same allowlist on every binding keeps the filter bar, counts and every component consistent.
      const allowed = spec.filters.map((entry) => ({ fieldId: f[entry.key], operators: entry.operators }));
      return spec.bindings({ f, containers, masterTeus, houseTeus }).map((binding) => ({
        name: binding.name, query: binding.query,
        // Sparkline histories ignore the period on purpose: a trend always shows the whole history of the visible rows.
        allowedFilters: binding.noDate ? allowed.filter((entry) => entry.fieldId !== f.date) : allowed,
      }));
    },
    document: ({ fieldId, binding }) => {
      const f = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, fieldId(key)]));
      const built = spec.items({ f, binding });
      return document(spec.panel.name, built);
    },
  };
}

function item(id, type, props, bindings, desktop, tablet = {}, mobile = {}) {
  return { id, type, props, bindings, desktop, tablet: { ...tablet }, mobile: { ...mobile } };
}

/** Desktop is a fixed 12-column matrix (rows of ROW_HEIGHT px stretched to the viewport); tablet/mobile reflow in reading order. */
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
  // Layouts below are authored under a 3-row filter band; the compact filter bar needs 2, so the body moves up one row.
  if (items.some((entry) => entry.type === "filter_bar")) for (const entry of items) if (entry.type !== "filter_bar" && entry.desktop.y >= 3) entry.desktop = { ...entry.desktop, y: entry.desktop.y - 1 };
  return {
    schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
    sections: [{
      id: "dashboard", name: name, order: 0, layout: { variant: "grid", gap: "sm", rowHeight: ROW_HEIGHT, fit: true },
      components: items.map((entry, index) => ({
        id: entry.id, type: entry.type, schemaVersion: 1, props: entry.props, bindings: entry.bindings, order: index,
        layout: { desktop: entry.desktop, tablet: tablet.get(entry.id), mobile: { ...mobile.get(entry.id), w: 12, x: 0 } },
      })),
    }],
  };
}

// Control names follow the Looker reference (Month / Year, Entry Port, ...); the dataset's own field names are not renamed.
const FILTER_LABELS = {
  arrival_date: l("Month / Year"),
  house_port_of_arrival: l("Entry Port"), house_port_of_departure: l("Departure Port"), house_country_of_origin: l("Country of Origin"),
  master_country_of_origin: l("Country of Origin"), master_bill_of_lading_nbr: l("Master BL Number"),
};
const filterBar = (extra = {}) => item("filters", "filter_bar", { title: l("Filtros", "Filters"), labels: { ...FILTER_LABELS, ...extra } }, {}, { x: 0, y: 0, w: 12, h: 2 }, { h: 4 }, { h: 4 });

function richText(content) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] };
}
const nav = (id, panelSlug, label) => ({ id, text: label, panelSlug });

const col = (key, label, kind, width, extra = {}) => ({ key, label: l(label), kind, sortable: kind !== "rank", width, ...(kind === "bar" ? { barTone: "blue" } : {}), ...extra });
const trendCol = () => ({ key: "trend", label: l("Tendencia", "Trend"), kind: "sparkline", width: 84 });
const actionsCol = () => ({ key: "actions", label: l("Acciones", "Actions"), kind: "actions", align: "center", width: 64 });

function dataGrid(title, columns, options = {}, ..._rest) {
  const { trend, search = true, exportable = true, defaultSort = { key: "containers", direction: "DESC" }, pageSizes = [10, 20, 30], defaultPageSize = 20 } = options;
  return { title: l(title), columns, pageSizes, defaultPageSize, defaultSort, searchable: search, selectable: false, exportable, ...(trend ? { trend } : {}) };
}

const barProps = (title, categoryKey, color) => ({ title: l(title), categoryKey, series: [{ key: "containers", label: l("Contenedores", "Containers"), color }], horizontal: true, height: 240, showValues: true });
const originBarProps = (title, countryKey, portKey, drillTitle) => ({ ...barProps(title, countryKey, BLUE), drill: { binding: "drill", categoryKey: portKey, title: l(drillTitle, "Departure ports") } });
const carrierDonutProps = (title, categoryKey, legend = "right") => ({ title: l(title), categoryKey, valueKey: "containers", maxSlices: 5, totalKey: "containers", height: 240, variant: "donut", showTotal: true, centerLabel: l("Contenedores", "Containers"), legend });

/** The common "table on the left (≈60 %), map + bars + donut stacked on the right" body of Search By and Master Consignee List. */
function standardBody(f, binding, parts) {
  void f; void binding;
  return [
    filterBar(),
    item("table", "data_grid", parts.table.props, parts.table.bindings, { x: 0, y: 3, w: 7, h: 15 }, { h: 14 }),
    item("map", "geo_map", parts.map.props, parts.map.bindings, { x: 7, y: 3, w: 5, h: 5 }, { h: 8 }),
    item("origin", "bar_chart", parts.bars.props, parts.bars.bindings, { x: 7, y: 8, w: 5, h: 5 }, { h: 8 }),
    item("carriers", "donut_chart", parts.donut.props, parts.donut.bindings, { x: 7, y: 13, w: 5, h: 5 }, { h: 8 }),
  ];
}

const geoMap = (title, regionKey, valueKey, secondaryKey, data) => ({ props: { title: l(title), regionKey, valueKey, secondaryKey, valueLabel: l("Peso (MT)", "Weight (MT)"), secondaryLabel: l("Contenedores", "Containers") }, bindings: { data } });
const originBars = (title, countryKey, portKey, drillTitle, data, drill) => ({ props: originBarProps(title, countryKey, portKey, drillTitle), bindings: { data, drill } });
const carrierDonut = (title, categoryKey, data, total) => ({ props: carrierDonutProps(title, categoryKey), bindings: { data, total } });
