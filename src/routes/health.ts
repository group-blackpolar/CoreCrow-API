import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/database.js";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async (req, reply) => {
    return reply.redirect("/health");
  });

  app.get("/health", async (req, reply) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const raw: any[] = await prisma.$queryRaw`
      SELECT "checkedAt", "ok", "responseTimeMs"
      FROM "UptimeCheck"
      WHERE "checkedAt" >= ${thirtyDaysAgo}
      ORDER BY "checkedAt" ASC
    `;
    const checks = raw.map((r) => ({
      checkedAt: new Date(r.checkedAt),
      ok: Boolean(r.ok),
      responseTimeMs: Number(r.responseTimeMs),
    }));

    // Agrupa por día (YYYY-MM-DD)
    const dayMap = new Map<string, { total: number; ok: number; sumMs: number }>();
    for (const c of checks) {
      const key = c.checkedAt.toISOString().slice(0, 10);
      const entry = dayMap.get(key) ?? { total: 0, ok: 0, sumMs: 0 };
      entry.total += 1;
      if (c.ok) entry.ok += 1;
      entry.sumMs += c.responseTimeMs;
      dayMap.set(key, entry);
    }

    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.now() - (29 - i) * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const entry = dayMap.get(key);
      
      let status: "ok" | "degraded" | "down" | "empty" = "empty";
      if (entry) {
        if (entry.ok === entry.total) status = "ok";
        else if (entry.ok > 0) status = "degraded";
        else status = "down";
      }

      return {
        date: key,
        status,
        avgMs: entry ? Math.round(entry.sumMs / entry.total) : 0,
        checks: entry?.total ?? 0,
      };
    });

    const totalChecks = checks.length;
    const okChecks = checks.filter((c) => c.ok).length;
    const uptimePct = totalChecks > 0 ? ((okChecks / totalChecks) * 100).toFixed(1) : "100.0";
    
    // Promedio de tiempo de respuesta global
    const totalMs = checks.reduce((acc, c) => acc + c.responseTimeMs, 0);
    const avgResponseTime = totalChecks > 0 ? (totalMs / totalChecks / 1000).toFixed(2) : "0.00";

    // Generar puntos SVG para el gráfico de latencia/Response Time
    const width = 500;
    const height = 60;
    const padding = 5;

    // Calcular máximo para escalar el gráfico
    const maxMs = Math.max(...days.map((d) => d.avgMs), 100);

    const svgPoints = days.map((d, i) => {
      const x = (i / (days.length - 1)) * width;
      const y = height - padding - (d.avgMs / maxMs) * (height - 2 * padding);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const bars = days
      .map((d) => {
        let cls = "bar-empty";
        if (d.status === "ok") cls = "bar-ok";
        if (d.status === "degraded") cls = "bar-degraded";
        if (d.status === "down") cls = "bar-down";

        return `<div class="bar ${cls}" 
          data-date="${d.date}"
          data-status="${d.status}"
          data-avgms="${d.avgMs}"
          data-checks="${d.checks}"
        ></div>`;
      })
      .join("");

    const currentDateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const currentTimeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    const serverTimestamp = new Date().toISOString();

    reply.type("text/html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <title>CoreCrow - Health</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f8f9fa;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 2rem 1rem;
      display: flex;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      width: 100%;
      max-width: 580px;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    
    /* Compact Top Bar */
    .card-sm {
      position: relative; 
      border-radius: 10px;
      padding: 0.6rem 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      background: #ffffff;
      border: 1px solid #e5e7eb;
    }

    .top-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: #6b7280;
      flex-wrap: wrap;
    }

    .top-bar .dot {
      display: inline-block;
      width: 3px;
      height: 3px;
      background: #d1d5db;
      border-radius: 50%;
    }

    .top-bar img {
      height: 20px;
      width: auto;
    }

    /* Main Title */
    .main-title {
      text-align: center;
      font-size: 1.5rem;
      font-weight: 700;
      color: #10b981;
      margin: 0.5rem 0;
    }

    /* Cards */
    .card {
      position: relative; 
      border-radius: 16px;
      padding: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      background: #ffffff;
      border: 1px solid #e5e7eb;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .card-title {
      font-size: 1rem;
      font-weight: 600;
      color: #111827;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #f3f4f6;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      color: #4b5563;
      font-weight: 500;
    }
    .badge-dot {
      width: 6px;
      height: 6px;
      background: #10b981;
      border-radius: 50%;
    }

    .tooltip {
      position: absolute;
      display: none;
      pointer-events: none;
      background: #1e293b;
      color: #f8fafc;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.75rem;
      line-height: 1.4;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10;
      transform: translate(-50%, -120%);
      white-space: nowrap;
    }

    .tooltip.active {
      display: block;
    }

    .tooltip strong {
      display: block;
      color: #ffffff;
      margin-bottom: 2px;
    }

    /* Metric Line */
    .metric-container {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 1rem;
    }
    .metric-label {
      font-size: 0.875rem;
      color: #6b7280;
    }
    .metric-value {
      font-size: 0.875rem;
      font-weight: 600;
      color: #111827;
    }
    .metric-sub {
      font-weight: 400;
      color: #6b7280;
    }

    /* Chart / Bars */
    .chart {
      display: flex;
      gap: 2px;
      align-items: stretch;
      height: 42px;
      margin-bottom: 0.75rem;
      touch-action: manipulation;
    }
    .bar {
      flex: 1;
      border-radius: 3px;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .bar:hover, .bar:active { opacity: 0.8; }
    
    .bar-ok { background: #10b981; }
    .bar-degraded { background: #eab308; }
    .bar-down { background: #ef4444; }
    .bar-empty { background: #e5e7eb; }

    /* SVG Line Chart */
    .line-chart-container {
      width: 100%;
      height: 60px;
      margin-bottom: 0.75rem;
    }
    .line-chart-container svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .chart-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.7rem;
      color: #9ca3af;
    }

    /* Ajustes específicos para pantallas pequeñas (Mobile) */
    @media (max-width: 480px) {
      body {
        padding: 1rem 0.75rem;
      }
      .card {
        padding: 1rem;
      }
      .main-title {
        font-size: 1.25rem;
      }
      .top-bar {
        font-size: 0.7rem;
        gap: 0.35rem;
      }
      .top-bar .dot:nth-of-type(2) {
        display: none; /* Oculta separadores extra en pantallas muy estrechas si quiebra línea */
      }
    }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- Header info -->
    <div class="card-sm">
      <div class="top-bar">
        <img src="/images/logoblack.png" alt="Black Polar" />
        <span>${currentDateStr}</span>
        <span class="dot"></span>
        <span>Last update: <span id="client-time">...</span></span>
        <span class="dot"></span>
        <span>Uptime: ${hours}h ${minutes}m</span>
      </div>
    </div>

    <!-- Main Heading -->
    <h1 class="main-title">All systems operational</h1>

    <!-- Success Rate Card -->
    <div class="card">
      <div class="tooltip" id="tooltip"></div>

      <div class="card-header">
        <span class="card-title">Success rate</span>
        <div class="badge">
          <span class="badge-dot"></span>
          Operational
        </div>
      </div>

      <div class="metric-container">
        <span class="metric-label">Uptime</span>
        <span class="metric-value">${uptimePct}% <span class="metric-sub">- No issue</span></span>
      </div>

      <div class="chart">${bars}</div>
      
      <div class="chart-labels">
        <span>&lt; 30 days ago</span>
        <span>15 days ago</span>
        <span>Today</span>
      </div>
    </div>

    <!-- Response Time Card -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Response time</span>
        <div class="badge">
          <span class="badge-dot"></span>
          Operational
        </div>
      </div>

      <div class="metric-container">
        <span class="metric-label">Avg Latency</span>
        <span class="metric-value">${avgResponseTime} s <span class="metric-sub">- Normal</span></span>
      </div>

      <!-- Line Chart en SVG -->
      <div class="line-chart-container">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <polyline
            fill="none"
            stroke="#60a5fa"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            points="${svgPoints}"
          />
        </svg>
      </div>

      <div class="chart-labels">
        <span>&lt; 30 days ago</span>
        <span>15 days ago</span>
        <span>Today</span>
      </div>
    </div>
  </div>

  <script>
    const tooltip = document.getElementById('tooltip');
    const serverDate = new Date("${serverTimestamp}");
    
    function showTooltip(bar, clientX, clientY) {
      const date = bar.dataset.date;
      const status = bar.dataset.status;
      const avgMs = bar.dataset.avgms;
      const checks = Number(bar.dataset.checks);

      if (!checks || status === 'empty') {
        tooltip.innerHTML = '<strong>' + date + '</strong>No details';
      } else {
        let statusText = 'Operational';
        if (status === 'degraded') statusText = 'Minor Outages';
        if (status === 'down') statusText = 'Major Outage';

        tooltip.innerHTML = 
          '<strong>' + date + '</strong>' +
          'Status: ' + statusText + '<br/>' +
          'Avg response: ' + avgMs + ' ms<br/>' +
          'Checks: ' + checks;
      }

      const cardRect = bar.closest('.card').getBoundingClientRect();
      const x = clientX - cardRect.left;
      const y = clientY - cardRect.top;

      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.classList.add('active');
    }

    function hideTooltip() {
      tooltip.classList.remove('active');
    }

    document.querySelectorAll('.bar').forEach((bar) => {
      // Eventos para Mouse (Escritorio)
      bar.addEventListener('mouseenter', (e) => showTooltip(bar, e.clientX, e.clientY));
      bar.addEventListener('mousemove', (e) => showTooltip(bar, e.clientX, e.clientY));
      bar.addEventListener('mouseleave', hideTooltip);

      // Eventos Táctiles (Móviles)
      bar.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
          const touch = e.touches[0];
          showTooltip(bar, touch.clientX, touch.clientY);
        }
      }, { passive: true });
    });

    // Ocultar tooltip si se toca fuera
    document.addEventListener('touchstart', (e) => {
      if (!e.target.classList.contains('bar')) {
        hideTooltip();
      }
    }, { passive: true });

    document.getElementById('client-date').textContent = serverDate.toLocaleDateString(navigator.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    document.getElementById('client-time').textContent = serverDate.toLocaleTimeString(navigator.language, {
      hour12: false,
      timeZoneName: 'short' // Muestra el GMT o la abreviación de la zona del cliente
    });

  </script>
</body>
</html>
    `);
  });
}