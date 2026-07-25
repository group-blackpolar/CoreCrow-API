import { prisma } from "../lib/database.js";
const startedAt = Date.now();
export async function healthRoutes(app) {
    app.get("/", async (req, reply) => {
        return reply.redirect("/health");
    });
    app.get("/health", async (req, reply) => {
        const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const raw = await prisma.$queryRaw `
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
        const dayMap = new Map();
        for (const c of checks) {
            const key = c.checkedAt.toISOString().slice(0, 10);
            const entry = dayMap.get(key) ?? { total: 0, ok: 0, sumMs: 0 };
            entry.total += 1;
            if (c.ok)
                entry.ok += 1;
            entry.sumMs += c.responseTimeMs;
            dayMap.set(key, entry);
        }
        const days = Array.from({ length: 30 }, (_, i) => {
            const d = new Date(Date.now() - (29 - i) * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10);
            const entry = dayMap.get(key);
            let status = "empty";
            if (entry) {
                if (entry.ok === entry.total)
                    status = "ok";
                else if (entry.ok > 0)
                    status = "degraded"; // Para casos con caídas parciales
                else
                    status = "down";
            }
            return {
                date: key,
                status,
                avgMs: entry ? Math.round(entry.sumMs / entry.total) : null,
                checks: entry?.total ?? 0,
            };
        });
        const totalChecks = checks.length;
        const okChecks = checks.filter((c) => c.ok).length;
        const uptimePct = totalChecks > 0 ? ((okChecks / totalChecks) * 100).toFixed(1) : "100.0";
        // Promedio de tiempo de respuesta global
        const totalMs = checks.reduce((acc, c) => acc + c.responseTimeMs, 0);
        const avgResponseTime = totalChecks > 0 ? (totalMs / totalChecks / 1000).toFixed(2) : "0.00";
        const bars = days
            .map((d, i) => {
            let cls = "bar-empty";
            if (d.status === "ok")
                cls = "bar-ok";
            if (d.status === "degraded")
                cls = "bar-degraded";
            if (d.status === "down")
                cls = "bar-down";
            return `<div class="bar ${cls}" data-index="${i}"></div>`;
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
    .top-bar {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.8rem;
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
      background: #ffffff;
      border: 1px solid #f3f4f6;
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
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

    .chart-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: #9ca3af;
    }

    /* Detail Modal / Tooltip area */
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
    <div class="top-bar">
      <span>${currentDateStr}</span>
      <span class="dot"></span>
      <span>Last update: ${currentTimeStr}</span>
    </div>

    <!-- Main Heading -->
    <h1 class="main-title">All systems operational</h1>

    <!-- Success Rate Card -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Success rate</span>
        <div class="badge">
          <span class="badge-dot"></span>
          operational
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

      <div class="detail" id="detail"></div>
    </div>

    <!-- Response Time Card -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Response time</span>
        <div class="badge">
          <span class="badge-dot"></span>
          operational
        </div>
      </div>

      <div class="metric-container">
        <span class="metric-label">Average</span>
        <span class="metric-value">${avgResponseTime}s <span class="metric-sub">- Normal latency</span></span>
      </div>
    </div>

    <div class="footer">
      Process uptime: ${hours}h ${minutes}m
    </div>

  </div>

  <script>
    const days = ${JSON.stringify(days)};
    const detail = document.getElementById('detail');
    
    document.querySelectorAll('.bar').forEach((bar) => {
      bar.addEventListener('click', () => {
        const d = days[Number(bar.dataset.index)];
        if (!d.checks) {
          detail.innerHTML = '<strong>' + d.date + '</strong>No check data recorded for this day.';
        } else {
          let statusText = 'Operational';
          if (d.status === 'degraded') statusText = 'Minor Outages';
          if (d.status === 'down') statusText = 'Major Outage';

          detail.innerHTML = '<strong>' + d.date + '</strong>' +
            statusText + ' · Avg response: ' + d.avgMs + 'ms · ' +
            d.checks + ' checks';
        }
        detail.classList.add('active');
      });
    });
  </script>
</body>
</html>
    `);
    });
}
