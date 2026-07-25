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
      // Invertir Y porque en SVG 0 es arriba
      const y = height - padding - (d.avgMs / maxMs) * (height - 2 * padding);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const bars = days
      .map((d, i) => {
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

    reply.type("text/html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>CoreCrow - System Status</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f8f9fa;
      background-image: url('https://i.pinimg.com/originals/4b/65/28/4b65285a3d31f68d1350e8b23c19ddd7.gif');
      background-size: cover;         
      background-position: center;     
      background-repeat: no-repeat;    
      background-attachment: fixed;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 3rem 1rem;
      display: flex;
      justify-content: center;

      
    }
    .container {
      width: 100%;
      max-width: 580px;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    /* Header Timestamp */
    
    .card-sm {
      position: relative; 
      border-radius: 16px;
      padding: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
      background: rgba(255, 255, 255, 0.85); 
      backdrop-filter: blur(8px);        
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
    }

    .top-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.75rem;
      font-size: 1rem;
      color: #9ca3af;
      margin-bottom: 0.5rem;
    }

    .top-bar .dot {
      display: inline-block;
      width: 3px;
      height: 3px;
      background: #d1d5db;
      border-radius: 50%;
    }

    .top-bar img {
      height: 24px;
    }

    .card-sm .top-bar {
      margin-bottom: 0;
      gap: 0.5rem;
      font-size: 0.75rem;
    }

    .card-sm .top-bar img {
      height: 24px;
    }

    /* Main Title */
    .main-title {
      text-align: center;
      font-size: 1.75rem;
      font-weight: 700;
      color: #10b981;
      margin: 0 0 1rem 0;
    }

    /* Cards */
    .card {
      position: relative; 
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
      background: rgba(255, 255, 255, 0.85); 
      backdrop-filter: blur(8px);        
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
    }
    .card-title {
      font-size: 1.1rem;
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
      pointer-events: none; /* Evita que el tooltip interfiera con el mouse */
      background: #1e293b;
      color: #f8fafc;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.75rem;
      line-height: 1.4;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10;
      transform: translate(-50%, -120%); /* Lo posiciona justo arriba del cursor */
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
      font-size: 0.9rem;
      color: #6b7280;
    }
    .metric-value {
      font-size: 0.9rem;
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
      gap: 3px;
      align-items: stretch;
      height: 48px;
      margin-bottom: 0.75rem;
    }
    .bar {
      flex: 1;
      border-radius: 4px;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .bar:hover { opacity: 0.8; }
    
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
      font-size: 0.75rem;
      color: #9ca3af;
    }

    /* Detail Tooltip area */
    .detail {
      display: none;
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background: #f9fafb;
      border-radius: 8px;
      font-size: 0.8rem;
      color: #4b5563;
    }
    .detail.active { display: block; }
    .detail strong { color: #111827; display: block; margin-bottom: 2px; }

    /* Footer */
    .footer {
      font-size: 0.75rem;
      color: #9ca3af;
      text-align: center;
      margin-top: 1rem;
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
      <span>Last update: ${currentTimeStr}</span>
      <span class="dot"></span>
      <span>Process uptime: ${hours}h ${minutes}m</span>
    </div>
  </div>

    <!-- Main Heading -->
    <h1 class="main-title">All systems operational</h1>

    <!-- Success Rate Card -->
<!-- Success Rate Card -->
    <div class="card">
      <!-- Mueve el tooltip AQUÍ para que sea hijo directo de .card -->
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
        <span class="metric-value">${uptimePct}% <span class="metric-sub">- No current issue</span></span>
      </div>

      <div class="chart">${bars}</div>
      
      <div class="chart-labels">
        <span>&lt; 30 days ago</span>
        <span>15 days ago</span>
        <span>Today</span>
      </div>

      <!-- Eliminamos <div class="detail"> ya no es necesario -->
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
        <span class="metric-label">Uptime</span>
        <span class="metric-value">${avgResponseTime} sn <span class="metric-sub">- No current issue</span></span>
      </div>

      <!-- Line Chart en SVG -->
      <div class="line-chart-container">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <!-- Línea con los promedios de ms -->
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
    const days = ${JSON.stringify(days)};
    const tooltip = document.getElementById('tooltip');
    
    document.querySelectorAll('.bar').forEach((bar) => {
        bar.addEventListener('mouseenter', (e) => {
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
          tooltip.classList.add('active');
        });

        bar.addEventListener('mousemove', (e) => {
          const cardRect = bar.closest('.card').getBoundingClientRect();
          const x = e.clientX - cardRect.left;
          const y = e.clientY - cardRect.top;

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        });

        bar.addEventListener('mouseleave', () => {
          tooltip.classList.remove('active');
        });
      });
  </script>
</body>
</html>
    `);
  });
}