const statusLabel = (available) => available ? "Operativo" : "Degradado";
const moduleLabels = {
    Identity: "Identidad",
    Authorization: "Autorización",
    "Multi-tenancy": "Multiempresa",
    Audit: "Auditoría",
    Security: "Seguridad",
    Commerce: "Comercio",
    "Business services": "Servicios empresariales",
};
const durationLabel = (seconds) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
function trafficChart(summary) {
    if (!summary.requests)
        return `<div class="empty-chart" role="img" aria-label="Todavía no hay solicitudes observadas">
      <div class="grid-lines" aria-hidden="true"></div>
      <strong>Esperando tráfico real</strong>
      <span>La telemetría comenzó ${durationLabel(summary.coverageSeconds)} atrás. Los datos aparecerán sin recargar valores simulados.</span>
    </div>`;
    const width = 640;
    const height = 176;
    const padding = 18;
    const maximum = Math.max(1, ...summary.series.map((bucket) => bucket.requests));
    const points = summary.series
        .map((bucket, index) => {
        const x = padding +
            (index / Math.max(1, summary.series.length - 1)) *
                (width - padding * 2);
        const y = height - padding - (bucket.requests / maximum) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
        .join(" ");
    const first = summary.series[0]?.startedAt.slice(11, 16) ?? "";
    const last = summary.series.at(-1)?.startedAt.slice(11, 16) ?? "";
    return `<div class="traffic-chart" role="img" aria-label="Solicitudes reales agrupadas cada cinco minutos">
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true" preserveAspectRatio="none"><path class="traffic-area" d="M ${padding},${height - padding} L ${points.replaceAll(" ", " L ")} L ${width - padding},${height - padding} Z"></path><polyline points="${points}"></polyline></svg>
    <div><span>${first} UTC</span><strong>${summary.requests} solicitudes observadas</strong><span>${last} UTC</span></div>
  </div>`;
}
export function healthPage(state, summary) {
    const apiUp = state.status === "operational";
    const databaseUp = state.modules.every((module) => module.status === "available");
    const authModules = state.modules.filter((module) => ["Identity", "Authorization", "Security"].includes(module.name));
    const authUp = authModules.length === 3 &&
        authModules.every((module) => module.status === "available");
    const duration = durationLabel(state.uptimeSeconds);
    const checkedAt = state.checkedAt.slice(11, 19);
    const services = [
        ["API", apiUp, `Contrato ${state.apiVersion}`],
        ["Base de datos", databaseUp, "Persistencia de CoreCrow"],
        ["Autenticación", authUp, "Identidad y políticas"],
    ];
    const averageLatency = summary.latencyMs.average;
    const emailLabel = {
        available: "Disponible (conexión verificada)",
        unavailable: "Configurada, sin conexión",
        not_configured: "No configurada",
    }[state.emailTransport];
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Estado operativo en vivo de la API de CoreCrow.">
  <title>Estado de CoreCrow API · Black Polar</title>
  <link rel="stylesheet" href="/status.css?v=brand-1">
  <script src="/status.js?v=es-1" defer></script>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="https://blackpolar.org/es-lat" aria-label="Inicio de Black Polar"><span><img class="logo-light" src="/images/logo-black.png" alt=""><img class="logo-dark" src="/images/logo-white.png" alt=""></span> BLACK POLAR</a>
    <div class="topbar-actions"><span class="environment">CORECROW / PRODUCCIÓN</span><button class="theme-toggle" type="button" aria-label="Apariencia: Claro" title="Cambiar a tema oscuro"><span aria-hidden="true">☼</span><b aria-hidden="true"></b><span aria-hidden="true">☾</span></button></div>
  </header>
  <main class="shell">
    <section class="hero">
      <div>
        <span class="eyebrow">ESTADO PÚBLICO DEL SISTEMA</span>
        <h1>CoreCrow <span>panel de la API</span></h1>
        <p>Disponibilidad actual de la base de servicios compartida que conecta los productos de Black Polar.</p>
      </div>
      <div class="status ${apiUp ? "" : "degraded"}">${statusLabel(apiUp)}</div>
    </section>

    <section aria-labelledby="metrics-title">
      <div class="section-heading"><div><span class="index">01</span><h2 id="metrics-title">Métricas clave</h2></div><p>Solo valores reales. No se simulan datos de producción.</p></div>
      <div class="metrics">
        <article><small>Solicitudes / segundo</small><strong>${summary.requestsPerSecond.toFixed(3)}</strong><span>${summary.requests} solicitudes durante ${durationLabel(summary.coverageSeconds)} de cobertura</span></article>
        <article><small>Latencia promedio</small><strong${averageLatency === null ? ' class="unavailable-value"' : ""}>${averageLatency === null ? "—" : `${averageLatency.toFixed(2)} ms`}</strong><span>${summary.latencyMs.p95 === null ? "Esperando la primera solicitud" : `p95 ≤ ${summary.latencyMs.p95} ms`}</span></article>
        <article><small>Tiempo activo del proceso</small><strong>${duration}</strong><span>Desde el inicio de esta instancia</span></article>
        <article><small>Errores 4xx / 5xx</small><strong>${summary.errors.client} / ${summary.errors.server}</strong><span>Conteos agregados; sin rutas ni datos de usuarios</span></article>
      </div>
    </section>

    <section class="dashboard-grid">
      <div class="services" aria-labelledby="services-title">
        <div class="panel-heading"><div><span class="index">02</span><h2 id="services-title">Estado de los servicios</h2></div><span>Comprobado ${checkedAt} UTC</span></div>
        ${services
        .map(([name, available, detail]) => `<article><div><span><strong>${name}</strong><small>${detail}</small></span></div><b class="pill ${available ? "" : "degraded"}">${statusLabel(available)}</b></article>`)
        .join("")}
      </div>

      <div class="chart-panel" aria-labelledby="traffic-title">
        <div class="panel-heading"><div><span class="index">03</span><h2 id="traffic-title">Historial de tráfico</h2></div><span>24 horas</span></div>
        ${trafficChart(summary)}
      </div>
    </section>

    <section class="details" aria-labelledby="details-title">
      <div class="panel-heading"><div><span class="index">04</span><h2 id="details-title">Detalle de dependencias</h2></div><span>Caché de 15 segundos</span></div>
      <div class="dependency-list">${state.modules
        .map((module) => `<div><span>${moduleLabels[module.name] ?? module.name}</span><b class="pill ${module.status === "available" ? "" : "degraded"}">${module.status === "available" ? "Disponible" : "No disponible"}</b></div>`)
        .join("")}</div>
      <div class="integration-note"><span>Entrega de correo</span><strong>${emailLabel}</strong></div>
    </section>

    <nav aria-label="Recursos técnicos"><a href="/v1/health">Salud en JSON ↗</a><a href="/v1/status/summary?window=24h">Telemetría agregada ↗</a><a href="https://blackpolar.org/es-lat">Black Polar ↗</a></nav>
  </main>
  <footer class="shell"><span>CORECROW / BLACK POLAR</span><span>Estado público del servicio · UTC</span></footer>
</body>
</html>`;
}
