// src/lib/uptimeMonitor.ts
import { prisma } from "./database.js";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos
export function startUptimeMonitor() {
    setInterval(async () => {
        const start = Date.now();
        let ok = true;
        try {
            await prisma.$queryRaw `SELECT 1`;
        }
        catch {
            ok = false;
        }
        const responseTimeMs = Date.now() - start;
        // prisma may not have a generated "uptimeCheck" client. Use it if present,
        // otherwise fall back to a raw INSERT into a likely table name.
        const uptimeClient = prisma.uptimeCheck;
        if (uptimeClient && typeof uptimeClient.create === "function") {
            await uptimeClient.create({ data: { responseTimeMs, ok } }).catch(() => { });
        }
        else {
            // fallback: attempt raw insert into a common table name. Adjust if needed.
            await prisma
                .$executeRaw `INSERT INTO uptime_checks (response_time_ms, ok) VALUES (${responseTimeMs}, ${ok})`
                .catch(() => { });
        }
    }, CHECK_INTERVAL_MS);
}
