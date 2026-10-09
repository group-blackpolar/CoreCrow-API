// SHARK · Consignee Analytics. Everything SHARK-specific lives here (dataset keys, queries, copy, layout); the components,
// renderer and runner are generic. Metric rules (Master-House granularity):
//   containers     COUNT_DISTINCT container_number          (a container can appear in several Master/House rows)
//   weight (MT)    SUM house_weight_mt over rows kept by the import (exact duplicates are skipped at import time)
//   consignees     COUNT_DISTINCT master_consignee / house_consignee
//   country, port, carrier: House side (the party that holds the cargo documents at destination)
const l = (es, en = es) => ({ es, en });

const measure = (operation, fieldId, alias) => ({ operation, ...(fieldId ? { fieldId } : {}), alias });
const agg = (spec) => ({ mode: "AGGREGATE", ...spec });

export default {
  datasetSlug: "master-house",
  category: { name: l("Analítica", "Analytics"), slug: "analitica", icon: "chart-line", color: "#2F6FED" },
  subcategory: { name: l("Consignatarios", "Consignees"), slug: "consignatarios", icon: "users-three" },
  panel: { name: l("Consignee Analytics"), description: l("Análisis de contenedores y peso por Master y House Consignee", "Container and weight analysis by Master and House Consignee"), slug: "consignee-analytics", icon: "chart-bar", audienceType: "ALL_MEMBERS" },

  bindings: ({ fieldId }) => {
    const date = fieldId("arrival_date");
    const container = fieldId("container_number");
    const master = fieldId("master_consignee");
    const house = fieldId("house_consignee");
    const country = fieldId("house_country_of_origin");
    const entryPort = fieldId("house_port_of_arrival");
    const departurePort = fieldId("house_port_of_departure");
    const carrier = fieldId("house_carrier");
    const weight = fieldId("house_weight_mt");
    // The same allowlist on every binding keeps the filter bar, counts and every component consistent.
    const filters = [
      { fieldId: master, operators: ["IN", "EQ"] },
      { fieldId: house, operators: ["IN", "EQ"] },
      { fieldId: entryPort, operators: ["IN", "EQ"] },
      { fieldId: departurePort, operators: ["IN", "EQ"] },
      { fieldId: country, operators: ["IN", "EQ"] },
      { fieldId: carrier, operators: ["IN", "EQ"] },
      { fieldId: date, operators: ["GTE", "LTE"] },
    ];
    const containers = measure("COUNT_DISTINCT", container, "containers");
    const ranking = (group, extra = []) => agg({ groupBy: [group], measures: [containers, ...extra], orderBy: [{ key: "containers", direction: "DESC" }] });
    return [
      { name: "containers_total", query: agg({ measures: [containers], compareBy: date }), allowedFilters: filters },
      { name: "weight_total", query: agg({ measures: [measure("SUM", weight, "weight_mt")], compareBy: date }), allowedFilters: filters },
      { name: "master_consignees", query: agg({ measures: [measure("COUNT_DISTINCT", master, "master_consignees")], compareBy: date }), allowedFilters: filters },
      { name: "house_consignees", query: agg({ measures: [measure("COUNT_DISTINCT", house, "house_consignees")], compareBy: date }), allowedFilters: filters },
      { name: "top_country", query: { ...ranking(country), limit: 1 }, allowedFilters: filters },
      { name: "last_update", query: agg({ measures: [measure("MAX", date, "last_date")] }), allowedFilters: filters },
      {
        name: "results",
        query: agg({
          groupBy: [master, house, country],
          measures: [containers, measure("SUM", weight, "weight_mt"), measure("MAX", date, "last_date")],
          orderBy: [{ key: "containers", direction: "DESC" }], limit: 100, includeTotal: true, searchFieldIds: [master, house],
        }),
        allowedFilters: filters,
      },
      {
        // Monthly history of the rows on screen; deliberately ignores the date filter so a sparkline always has a history.
        name: "results_trend",
        query: agg({ groupBy: [master, house, country, date], granularity: { [date]: "MONTH" }, measures: [containers], limit: 1000 }),
        allowedFilters: filters.filter((item) => item.fieldId !== date),
      },
      { name: "countries", query: { ...ranking(country, [measure("SUM", weight, "weight_mt")]), limit: 200 }, allowedFilters: filters },
      { name: "top_countries", query: { ...ranking(country), limit: 10 }, allowedFilters: filters },
      { name: "carriers", query: { ...ranking(carrier), limit: 30 }, allowedFilters: filters },
      { name: "ports", query: { ...ranking(entryPort), limit: 20 }, allowedFilters: filters },
      { name: "top_consignees", query: { ...ranking(master), limit: 10 }, allowedFilters: filters },
      { name: "monthly", query: agg({ groupBy: [date], granularity: { [date]: "MONTH" }, measures: [containers], orderBy: [{ key: date, direction: "ASC" }], limit: 100 }), allowedFilters: filters },
    ];
  },

  document: ({ fieldId, binding }) => {
    const country = fieldId("house_country_of_origin");
    const master = fieldId("master_consignee");
    const house = fieldId("house_consignee");
    const entryPort = fieldId("house_port_of_arrival");
    const carrier = fieldId("house_carrier");
    const date = fieldId("arrival_date");

    // Desktop positions are explicit; tablet and mobile reflow in reading order.
    const items = [];
    const add = (id, type, props, bindings, desktop, tablet = {}, mobile = {}) => items.push({ id, type, props, bindings, desktop, tablet, mobile });
    const kpi = (id, x, props, bindings) => add(id, "kpi_card", props, bindings, { x, y: 0, w: 2, h: 2 }, { w: 4, h: 2 }, { w: 12, h: 2 });

    kpi("kpi-containers", 0, { label: l("Total de contenedores", "Total containers"), valueKey: "containers", format: "number", icon: "container", tone: "blue", variant: "trend", comparison: {}, tooltip: l("Contenedores únicos (sin duplicar por relaciones Master-House)", "Unique containers (not duplicated by Master-House links)") }, { data: binding("containers_total") });
    kpi("kpi-weight", 2, { label: l("Peso total (MT)", "Total weight (MT)"), valueKey: "weight_mt", format: "decimal", decimals: 2, icon: "scale", tone: "violet", variant: "trend", comparison: {}, tooltip: l("Suma del peso House en toneladas métricas", "Sum of House weight in metric tons") }, { data: binding("weight_total") });
    kpi("kpi-master", 4, { label: l("Master Consignees activos", "Active Master Consignees"), valueKey: "master_consignees", format: "number", icon: "users", tone: "green", variant: "trend", comparison: {} }, { data: binding("master_consignees") });
    kpi("kpi-house", 6, { label: l("House Consignees activos", "Active House Consignees"), valueKey: "house_consignees", format: "number", icon: "buildings", tone: "cyan", variant: "trend", comparison: {} }, { data: binding("house_consignees") });
    kpi("kpi-country", 8, { label: l("Principal país de origen", "Top country of origin"), valueKey: country, format: "text", icon: "globe", tone: "blue", variant: "standard", subtitle: { mode: "share", valueKey: "containers", totalKey: "containers", label: l("del total de contenedores", "of all containers") } }, { data: binding("top_country"), total: binding("containers_total") });
    kpi("kpi-update", 10, { label: l("Último movimiento registrado", "Latest recorded movement"), valueKey: "last_date", format: "date", icon: "clock", tone: "slate", variant: "standard", subtitle: { mode: "relative_date" } }, { data: binding("last_update") });

    add("filters", "filter_bar", { title: l("Filtros", "Filters") }, {}, { x: 0, y: 2, w: 12, h: 3 }, { w: 12, h: 3 }, { w: 12, h: 3 });
    add("results", "data_grid", {
      title: l("Resultados", "Results"),
      columns: [
        { key: master, label: l("Master Consignee"), kind: "text", sortable: true, width: 190 },
        { key: house, label: l("House Consignee"), kind: "text", sortable: true, width: 190 },
        { key: "containers", label: l("Contenedores", "Containers"), kind: "bar", sortable: true, barTone: "blue", width: 130 },
        { key: "weight_mt", label: l("Peso (MT)", "Weight (MT)"), kind: "decimal", sortable: true, width: 110 },
        { key: country, label: l("País de origen", "Country of origin"), kind: "badge", sortable: true, width: 150 },
        { key: "last_date", label: l("Últ. movimiento", "Last movement"), kind: "date", sortable: true, width: 120 },
        { key: "trend", label: l("Tendencia", "Trend"), kind: "sparkline", width: 100 },
        { key: "actions", label: l("Acciones", "Actions"), kind: "actions", align: "center", width: 72 },
      ],
      pageSizes: [10, 20, 50, 100], defaultPageSize: 20, defaultSort: { key: "containers", direction: "DESC" },
      searchable: true, selectable: true, exportable: true,
      trend: { binding: "trend", rowKeys: [master, house, country], categoryKey: date, valueKey: "containers" },
    }, { data: binding("results"), trend: binding("results_trend") }, { x: 0, y: 5, w: 8, h: 15 }, { w: 12, h: 14 }, { w: 12, h: 14 });
    add("map", "geo_map", { title: l("Distribución de contenedores por país de origen", "Containers by country of origin"), regionKey: country, valueKey: "containers", secondaryKey: "weight_mt", valueLabel: l("Contenedores", "Containers"), secondaryLabel: l("Peso (MT)", "Weight (MT)") }, { data: binding("countries") }, { x: 8, y: 5, w: 4, h: 7 }, { w: 12, h: 8 }, { w: 12, h: 9 });
    add("top-countries", "bar_chart", { title: l("Top países de origen por contenedores", "Top countries of origin by containers"), categoryKey: country, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: "#2F6FED" }], horizontal: true, height: 280, showValues: true }, { data: binding("top_countries") }, { x: 8, y: 12, w: 4, h: 7 }, { w: 6, h: 7 }, { w: 12, h: 8 });
    add("carriers", "donut_chart", { title: l("Volumen por línea naviera / agencia", "Volume by shipping line / agency"), categoryKey: carrier, valueKey: "containers", maxSlices: 5, totalKey: "containers", height: 260, variant: "donut", showTotal: true, centerLabel: l("Contenedores", "Containers"), legend: "right" }, { data: binding("carriers"), total: binding("containers_total") }, { x: 0, y: 20, w: 4, h: 8 }, { w: 6, h: 8 }, { w: 12, h: 9 });
    add("monthly", "line_chart", { title: l("Evolución mensual de contenedores", "Monthly container volume"), categoryKey: date, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: "#2F6FED" }], height: 280, variant: "area" }, { data: binding("monthly") }, { x: 4, y: 20, w: 4, h: 8 }, { w: 6, h: 8 }, { w: 12, h: 8 });
    add("ports", "bar_chart", { title: l("Contenedores por puerto de entrada", "Containers by entry port"), categoryKey: entryPort, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: "#7C5CFC" }], horizontal: true, height: 280, showValues: true }, { data: binding("ports") }, { x: 8, y: 19, w: 4, h: 9 }, { w: 12, h: 8 }, { w: 12, h: 8 });
    add("consignees", "bar_chart", { title: l("Top Master Consignees", "Top Master Consignees"), categoryKey: master, series: [{ key: "containers", label: l("Contenedores", "Containers"), color: "#1F9D63" }], horizontal: true, height: 280, showValues: true }, { data: binding("top_consignees") }, { x: 0, y: 28, w: 6, h: 8 }, { w: 12, h: 8 }, { w: 12, h: 8 });
    add("insights", "insights", {
      title: l("Insights y alertas", "Insights & alerts"),
      items: [
        { id: "leader", rule: "leader_share", binding: "countries", labelKey: country, valueKey: "containers", title: l("País de origen predominante", "Leading country of origin"), tone: "blue", icon: "globe" },
        { id: "change", rule: "period_change", binding: "change", valueKey: "containers", title: l("Contenedores vs. período anterior", "Containers vs. previous period"), tone: "green", icon: "trend" },
        { id: "ports", rule: "top_concentration", binding: "ports", labelKey: entryPort, valueKey: "containers", top: 2, title: l("Concentración en puertos de entrada", "Entry-port concentration"), tone: "amber", icon: "anchor" },
      ],
    }, { countries: binding("countries"), change: binding("containers_total"), ports: binding("ports") }, { x: 6, y: 28, w: 6, h: 8 }, { w: 12, h: 6 }, { w: 12, h: 8 });

    // Tablet / mobile: flow in reading order inside the 12-column grid.
    const flow = (device) => {
      let x = 0; let y = 0; let rowHeight = 0;
      const placed = new Map();
      for (const item of items) {
        const size = { w: 12, h: item.desktop.h, ...(item[device] ?? {}) };
        if (x + size.w > 12) { x = 0; y += rowHeight; rowHeight = 0; }
        placed.set(item.id, { x, y, w: size.w, h: size.h });
        x += size.w; rowHeight = Math.max(rowHeight, size.h);
      }
      return placed;
    };
    const tablet = flow("tablet");
    const mobile = flow("mobile");
    return {
      schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
      sections: [{
        id: "dashboard", name: l("Consignee Analytics"), order: 0, layout: { variant: "grid", gap: "md" },
        components: items.map((item, index) => ({
          id: item.id, type: item.type, schemaVersion: 1, props: item.props, bindings: item.bindings, order: index,
          layout: { desktop: item.desktop, tablet: tablet.get(item.id), mobile: mobile.get(item.id) },
        })),
      }],
    };
  },
};
