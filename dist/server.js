import { buildApp } from "./app.js";
import { prisma } from "./lib/database.js";
import { startContactNotificationWorker } from "./modules/business/contact-notifications.js";
if (process.env.NODE_ENV === "production") {
    if (!process.env.BETTER_AUTH_SECRET ||
        process.env.BETTER_AUTH_SECRET.length < 32)
        throw new Error("A strong BETTER_AUTH_SECRET is required");
    if (!process.env.BETTER_AUTH_URL?.startsWith("https://"))
        throw new Error("An HTTPS BETTER_AUTH_URL is required");
    if (!process.env.TRUSTED_ORIGINS)
        throw new Error("Explicit TRUSTED_ORIGINS are required");
    if (process.env.CONTACT_NOTIFICATIONS_ENABLED === "true" &&
        !process.env.CONTACT_NOTIFICATION_TO)
        throw new Error("CONTACT_NOTIFICATION_TO is required for notifications");
}
const app = await buildApp();
let stopContactNotifications;
for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
        stopContactNotifications?.();
        await app.close();
        await prisma.$disconnect();
    });
try {
    await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
    if (process.env.CONTACT_NOTIFICATIONS_ENABLED === "true")
        stopContactNotifications = startContactNotificationWorker((error) => app.log.error({ error }, "Contact notification worker failed"));
}
catch {
    app.log.error("API failed to start");
    await prisma.$disconnect();
    process.exitCode = 1;
}
