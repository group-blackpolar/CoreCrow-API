import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { auth } from "./lib/auth.js";
import { healthRoutes } from "./routes/health.js";
import { userRoutes } from "./routes/users.js";
import { authAdminRoutes } from "./routes/auth-admin.js";
const app = Fastify({
    logger: {
        level: process.env.NODE_ENV === "production" ? "warn" : "info",
    },
});
const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "http://localhost:3000,http://localhost:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
async function main() {
    await app.register(helmet);
    await app.register(cors, {
        origin: trustedOrigins,
        credentials: true,
    });
    await app.register(rateLimit, {
        max: 100,
        timeWindow: "1 minute",
    });
    // Better Auth maneja /api/auth/login, /api/auth/register, /api/auth/session, etc.
    app.all("/api/auth/*", async (request, reply) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = new Headers();
        Object.entries(request.headers).forEach(([key, value]) => {
            if (value)
                headers.append(key, value.toString());
        });
        const response = await auth.handler(new Request(url, {
            method: request.method,
            headers,
            body: request.method !== "GET" && request.method !== "HEAD"
                ? JSON.stringify(request.body)
                : undefined,
        }));
        reply.status(response.status);
        response.headers.forEach((value, key) => reply.header(key, value));
        return reply.send(await response.text());
    });
    await app.register(healthRoutes);
    await app.register(userRoutes, { prefix: "/api" });
    await app.register(authAdminRoutes, { prefix: "/api" });
    const port = Number(process.env.PORT) || 4000;
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`API corriendo en puerto ${port}`);
}
main().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
