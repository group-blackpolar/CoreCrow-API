import type { HealthSnapshot } from "./service.js";
import type { StatusSummary } from "../telemetry/service.js";

const statusLabel = (available: boolean) =>
  available ? "Operational" : "Degraded";

const moduleLabels: Record<string, string> = {
  Identity: "Identity",
  Authorization: "Authorization",
  "Multi-tenancy": "Multi-tenancy",
  Audit: "Audit",
  Security: "Security",
  Commerce: "Commerce",
  "Business services": "Business services",
};

const durationLabel = (seconds: number) =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

function trafficChart(summary: StatusSummary) {
  if (!summary.requests)
    return `<div class="empty-chart" role="img" aria-label="No requests observed yet">
      <div class="grid-lines" aria-hidden="true"></div>
      <strong>Waiting for real traffic</strong>
      <span>Telemetry started ${durationLabel(summary.coverageSeconds)} ago. Data will appear without loading simulated values.</span>
    </div>`;
  const width = 640;
  const height = 176;
  const padding = 18;
  const maximum = Math.max(
    1,
    ...summary.series.map((bucket) => bucket.requests),
  );
  const slotWidth = (width - padding * 2) / Math.max(1, summary.series.length);
  const barWidth = Math.max(1, Math.min(18, slotWidth * 0.62));
  const horizontalGrid = [0.25, 0.5, 0.75]
    .map((ratio) => {
      const y = padding + (height - padding * 2) * ratio;
      return `<line class="traffic-grid-line" x1="${padding}" y1="${y.toFixed(1)}" x2="${width - padding}" y2="${y.toFixed(1)}"></line>`;
    })
    .join("");
  const bars = summary.series
    .map((bucket, index) => {
      const x = padding + index * slotWidth + (slotWidth - barWidth) / 2;
      const measuredHeight =
        (bucket.requests / maximum) * (height - padding * 2);
      const barHeight = bucket.requests ? Math.max(3, measuredHeight) : 1;
      const y = height - padding - barHeight;
      const hasErrors = bucket.errors4xx + bucket.errors5xx > 0;
      const time = bucket.startedAt.slice(11, 16);
      return `<rect class="traffic-bar${bucket.requests ? "" : " is-empty"}${hasErrors ? " has-errors" : ""}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" tabindex="${bucket.requests ? "0" : "-1"}" data-time="${time} UTC" data-requests="${bucket.requests}" data-latency="${bucket.averageLatencyMs ?? "—"}" data-errors4xx="${bucket.errors4xx}" data-errors5xx="${bucket.errors5xx}" aria-label="${time} UTC: ${bucket.requests} requests, ${bucket.errors4xx} client errors, ${bucket.errors5xx} server errors"></rect>`;
    })
    .join("");
  const first = summary.series[0]?.startedAt.slice(11, 16) ?? "";
  const last = summary.series.at(-1)?.startedAt.slice(11, 16) ?? "";
  return `<div class="traffic-chart" role="group" aria-label="Real requests grouped into five-minute intervals">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${horizontalGrid}<line class="traffic-baseline" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"></line>${bars}</svg>
    <div class="chart-tooltip" role="tooltip" hidden><strong></strong><span class="tooltip-requests"></span><span class="tooltip-latency"></span><span class="tooltip-errors"></span></div>
    <div class="chart-summary"><span>${first} UTC</span><strong>${summary.requests} requests observed</strong><span>${last} UTC</span></div>
  </div>`;
}

export function healthPage(state: HealthSnapshot, summary: StatusSummary) {
  const apiUp = state.status === "operational";
  const databaseUp = state.modules.every(
    (module) => module.status === "available",
  );
  const authModules = state.modules.filter((module) =>
    ["Identity", "Authorization", "Security"].includes(module.name),
  );
  const authUp =
    authModules.length === 3 &&
    authModules.every((module) => module.status === "available");
  const duration = durationLabel(state.uptimeSeconds);
  const checkedAt = state.checkedAt.slice(11, 19);
  const services = [
    ["API", apiUp, `${state.apiVersion} contract`],
    ["Database", databaseUp, "CoreCrow persistence"],
    ["Authentication", authUp, "Identity and policies"],
  ] as const;
  const averageLatency = summary.latencyMs.average;
  const emailLabel = {
    available: "Available (connection verified)",
    unavailable: "Configured, connection unavailable",
    not_configured: "Not configured",
  }[state.emailTransport];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Live operational status for the CoreCrow API.">
  <title>CoreCrow API Status · Black Polar</title>
  <link rel="stylesheet" href="/status.css?v=dashboard-3">
  <script src="/status.js?v=dashboard-3" defer></script>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="https://blackpolar.org/en-us" aria-label="Black Polar home"><span><img class="logo-light" src="/images/logo-black.png" alt=""><img class="logo-dark" src="/images/logo-white.png" alt=""></span> BLACK POLAR</a>
    <div class="topbar-actions"><span class="environment">CORECROW / PRODUCTION</span><button class="theme-toggle" type="button" aria-label="Appearance: Light" title="Switch to dark theme"><span aria-hidden="true">☼</span><b aria-hidden="true"></b><span aria-hidden="true">☾</span></button></div>
  </header>
  <main class="shell">
    <section class="hero">
      <div>
        <span class="eyebrow">PUBLIC SYSTEM STATUS</span>
        <h1>CoreCrow <span>API dashboard</span></h1>
        <p>Live availability and real traffic signals for the shared service foundation behind Black Polar products.</p>
      </div>
      <div class="status ${apiUp ? "" : "degraded"}">${statusLabel(apiUp)}</div>
    </section>

    <section aria-labelledby="metrics-title">
      <div class="section-heading"><div><span class="index">01</span><h2 id="metrics-title">Key metrics</h2></div><p>Real values only. Production data is never simulated.</p></div>
      <div class="metrics">
        <article><small>Requests / second</small><strong>${summary.requestsPerSecond.toFixed(3)}</strong><span>${summary.requests} requests across ${durationLabel(summary.coverageSeconds)} of coverage</span></article>
        <article><small>Average latency</small><strong${averageLatency === null ? ' class="unavailable-value"' : ""}>${averageLatency === null ? "—" : `${averageLatency.toFixed(2)} ms`}</strong><span>${summary.latencyMs.p95 === null ? "Waiting for the first request" : `p95 ≤ ${summary.latencyMs.p95} ms`}</span></article>
        <article><small>Process uptime</small><strong>${duration}</strong><span>Since this instance started</span></article>
        <article><small>4xx / 5xx errors</small><strong>${summary.errors.client} / ${summary.errors.server}</strong><span>Aggregate counts without routes or user data</span></article>
      </div>
    </section>

    <section class="dashboard-grid">
      <div class="services" aria-labelledby="services-title">
        <div class="panel-heading"><div><span class="index">02</span><h2 id="services-title">Service status</h2></div><span>Checked ${checkedAt} UTC</span></div>
        ${services
          .map(
            ([name, available, detail]) =>
              `<article><div><span><strong>${name}</strong><small>${detail}</small></span></div><b class="pill ${available ? "" : "degraded"}">${statusLabel(available)}</b></article>`,
          )
          .join("")}
      </div>

      <div class="chart-panel" aria-labelledby="traffic-title">
        <div class="panel-heading"><div><span class="index">03</span><h2 id="traffic-title">Traffic history</h2></div><span>${summary.window} · ${durationLabel(summary.coverageSeconds)} observed</span></div>
        ${trafficChart(summary)}
      </div>
    </section>

    <section class="details" aria-labelledby="details-title">
      <div class="panel-heading"><div><span class="index">04</span><h2 id="details-title">Dependency details</h2></div><span>15-second cache</span></div>
      <div class="dependency-list">${state.modules
        .map(
          (module) =>
            `<div><span>${moduleLabels[module.name] ?? module.name}</span><b class="pill ${module.status === "available" ? "" : "degraded"}">${module.status === "available" ? "Available" : "Unavailable"}</b></div>`,
        )
        .join("")}</div>
      <div class="integration-note"><span>Email delivery</span><strong>${emailLabel}</strong></div>
    </section>

    <nav aria-label="Technical resources"><a href="/v1/health">Health JSON ↗</a><a href="/v1/status/summary?window=24h">Aggregate telemetry ↗</a><a href="https://blackpolar.org/en-us">Black Polar ↗</a></nav>
  </main>
  <footer class="shell"><span>CORECROW / BLACK POLAR</span><span>Public service status · UTC</span></footer>
</body>
</html>`;
}
