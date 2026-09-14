import { buildApp } from "./app.js";
import { prisma } from "./lib/database.js";
if (process.env.NODE_ENV === "production") {
    if (!process.env.BETTER_AUTH_SECRET ||
        process.env.BETTER_AUTH_SECRET.length < 32)
        throw new Error("A strong BETTER_AUTH_SECRET is required");
    if (!process.env.BETTER_AUTH_URL?.startsWith("https://"))
        throw new Error("An HTTPS BETTER_AUTH_URL is required");
    if (!process.env.TRUSTED_ORIGINS)
        throw new Error("Explicit TRUSTED_ORIGINS are required");
}
const app = await buildApp();
for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
        await app.close();
        await prisma.$disconnect();
    });
try {
    await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
}
catch {
    app.log.error("API failed to start");
    await prisma.$disconnect();
    process.exitCode = 1;
}
