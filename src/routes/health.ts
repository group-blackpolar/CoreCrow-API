// src/routes/health.ts
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
    // Use a raw query because the Prisma client in this project doesn't expose
    // an `uptimeCheck` property. Adjust the table/name as needed for your DB.
    const raw: any[] = await prisma.$queryRaw`
      SELECT "checkedAt", "ok", "responseTimeMs"
      FROM "UptimeCheck"
      WHERE "checkedAt" >= ${thirtyDaysAgo}
      ORDER BY "checkedAt" ASC
    `;
    const checks: { checkedAt: Date; ok: boolean; responseTimeMs: number }[] = raw.map((r) => ({
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
      return {
        date: key,
        ok: entry ? entry.ok === entry.total : null, // null = sin datos ese día
        avgMs: entry ? Math.round(entry.sumMs / entry.total) : null,
        checks: entry?.total ?? 0,
      };
    });

    const totalChecks = checks.length;
    const okChecks = checks.filter((c) => c.ok).length;
    const uptimePct = totalChecks > 0 ? ((okChecks / totalChecks) * 100).toFixed(2) : "100.00";

    const bars = days
      .map((d, i) => {
        const cls = d.ok === null ? "bar-empty" : d.ok ? "" : "bar-down";
        return `<div class="bar ${cls}" data-index="${i}"></div>`;
      })
      .join("");

    reply.type("text/html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>CoreCrow - Health</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #fdfcfa;
      color: #1a1a1a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 3rem 1.5rem;
    }
    .container { max-width: 640px; margin: 0 auto; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 2.5rem; }
    .logo img { height: 28px; }
    .logo span { font-weight: 600; font-size: 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
    .label { font-size: 0.85rem; color: #6b6b6b; margin-bottom: 0.25rem; }
    .uptime { font-size: 2.2rem; font-weight: 700; margin: 0.1rem 0; }
    .sub { font-size: 0.85rem; color: #b08d57; margin-bottom: 1.5rem; }
    .chart { display: flex; gap: 4px; align-items: flex-end; height: 90px; margin-bottom: 0.5rem; }
    .bar {
      flex: 1; height: 100%; background: #b8ecd4;
      border-top: 2px solid #2fbf82; border-radius: 2px 2px 0 0;
      cursor: pointer; transition: opacity 0.15s;
    }
    .bar:hover { opacity: 0.7; }
    .bar-down { background: #fbdada; border-top: 2px solid #e05353; }
    .bar-empty { background: #eee; border-top: 2px solid #ccc; }
    .chart-labels { display: flex; justify-content: space-between; font-size: 0.8rem; color: #b08d57; margin-bottom: 1rem; }
    .detail {
      display: none; padding: 0.9rem 1rem; background: #f5f1e8;
      border-radius: 8px; font-size: 0.85rem; margin-bottom: 2rem;
    }
    .detail.active { display: block; }
    .detail strong { display: block; margin-bottom: 4px; }
    .footer { margin-top: 2.5rem; font-size: 0.75rem; color: #999; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="/images/logoblack.png" alt="Black Polar" />
      <span>BLACK POLAR</span>
    </div>

    <h1>System Status</h1>

    <div class="label">Operational Status</div>
    <div class="uptime">${uptimePct}% uptime</div>
    <div class="sub">Últimos 30 días</div>

    <div class="chart">${bars}</div>
    <div class="chart-labels">
      <span>30 días atrás</span>
      <span>Hoy</span>
    </div>

    <div class="detail" id="detail"></div>

    <div class="footer">api.blackpolar.org · uptime del proceso: ${hours}h ${minutes}m</div>
  </div>

  <script>
    const days = ${JSON.stringify(days)};
    const detail = document.getElementById('detail');
    document.querySelectorAll('.bar').forEach((bar) => {
      bar.addEventListener('click', () => {
        const d = days[Number(bar.dataset.index)];
        if (!d.checks) {
          detail.innerHTML = '<strong>' + d.date + '</strong>Sin datos registrados ese día.';
        } else {
          detail.innerHTML = '<strong>' + d.date + '</strong>' +
            (d.ok ? 'Operativo' : 'Se detectaron fallas') + ' · ' +
            'Latencia promedio: ' + d.avgMs + 'ms · ' +
            d.checks + ' verificaciones';
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