const statusLabel = (available) => available ? "Operational" : "Degraded";
export function healthPage(state) {
    const apiUp = state.status === "operational";
    const databaseUp = state.modules.every((module) => module.status === "available");
    const authModules = state.modules.filter((module) => ["Identity", "Authorization", "Security"].includes(module.name));
    const authUp = authModules.length === 3 &&
        authModules.every((module) => module.status === "available");
    const duration = `${Math.floor(state.uptimeSeconds / 3600)}h ${Math.floor((state.uptimeSeconds % 3600) / 60)}m`;
    const checkedAt = state.checkedAt.slice(11, 19);
    const services = [
        ["API", apiUp, `Contract ${state.apiVersion}`],
        ["Database", databaseUp, "CoreCrow persistence"],
        ["Authentication", authUp, "Identity and policy"],
    ];
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Live operational status for the CoreCrow API.">
  <title>CoreCrow API status · Black Polar</title>
  <link rel="stylesheet" href="/status.css">
  <script src="/status.js" defer></script>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="https://blackpolar.org" aria-label="Black Polar home"><span><img src="/images/logoblack.png" alt=""></span> BLACK POLAR</a>
    <div class="topbar-actions"><span class="environment">CORECROW / PRODUCTION</span><button class="theme-toggle" type="button" aria-label="Appearance: Light" title="Switch to dark theme"><span aria-hidden="true">☼</span><b aria-hidden="true"></b><span aria-hidden="true">☾</span></button></div>
  </header>
  <main class="shell">
    <section class="hero">
      <div>
        <span class="eyebrow">PUBLIC SYSTEM STATUS</span>
        <h1>CoreCrow <span>API dashboard</span></h1>
        <p>Current readiness of the shared service foundation behind Black Polar products.</p>
      </div>
      <div class="status ${apiUp ? "" : "degraded"}">${statusLabel(apiUp)}</div>
    </section>

    <section aria-labelledby="metrics-title">
      <div class="section-heading"><div><span class="index">01</span><h2 id="metrics-title">Key metrics</h2></div><p>Live values only. No production data is simulated.</p></div>
      <div class="metrics">
        <article><small>Requests / second</small><strong class="unavailable-value">—</strong><span>Telemetry endpoint required</span></article>
        <article><small>Average latency</small><strong class="unavailable-value">—</strong><span>Telemetry endpoint required</span></article>
        <article><small>Process uptime</small><strong>${duration}</strong><span>Since this API instance started</span></article>
        <article><small>Errors 4xx / 5xx</small><strong class="unavailable-value">—</strong><span>Telemetry endpoint required</span></article>
      </div>
    </section>

    <section class="dashboard-grid">
      <div class="services" aria-labelledby="services-title">
        <div class="panel-heading"><div><span class="index">02</span><h2 id="services-title">Service status</h2></div><span>Checked ${checkedAt} UTC</span></div>
        ${services
        .map(([name, available, detail]) => `<article><div><span><strong>${name}</strong><small>${detail}</small></span></div><b class="pill ${available ? "" : "degraded"}">${statusLabel(available)}</b></article>`)
        .join("")}
      </div>

      <div class="chart-panel" aria-labelledby="traffic-title">
        <div class="panel-heading"><div><span class="index">03</span><h2 id="traffic-title">Traffic history</h2></div><span>24 hours</span></div>
        <div class="empty-chart" role="img" aria-label="Traffic history unavailable">
          <div class="grid-lines" aria-hidden="true"></div>
          <strong>No telemetry data</strong>
          <span>Connect an aggregated metrics endpoint to display request and uptime history.</span>
        </div>
      </div>
    </section>

    <section class="details" aria-labelledby="details-title">
      <div class="panel-heading"><div><span class="index">04</span><h2 id="details-title">Dependency detail</h2></div><span>Cached for 15 seconds</span></div>
      <div class="dependency-list">${state.modules
        .map((module) => `<div><span>${module.name}</span><b class="pill ${module.status === "available" ? "" : "degraded"}">${module.status === "available" ? "Available" : "Unavailable"}</b></div>`)
        .join("")}</div>
      <div class="integration-note"><span>Email delivery</span><strong>${state.emailDelivery === "configured" ? "Configured (delivery not probed)" : "Not configured"}</strong></div>
    </section>

    <nav aria-label="Developer resources"><a href="/v1/health">JSON health ↗</a><a href="https://blackpolar.org">Black Polar ↗</a></nav>
  </main>
  <footer class="shell"><span>CORECROW / BLACK POLAR</span><span>Public service status · UTC</span></footer>
</body>
</html>`;
}
