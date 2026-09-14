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
        await prisma.uptimeCheck
            .create({ data: { responseTimeMs, ok } })
            .catch((err) => {
            console.error("No se pudo registrar el uptime check:", err);
        });
    }, CHECK_INTERVAL_MS);
}
