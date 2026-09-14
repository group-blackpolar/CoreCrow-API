import { z } from "zod";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { identities } from "../modules/identity/repository.js";
import { users } from "../modules/identity/service.js";
import { fail } from "../shared/errors.js";
// Legacy adapter retains response shapes, delegates persistence and policy to identity.
export async function userRoutes(app) {
    app.addHook("preHandler", authenticateAdmin);
    app.get("/users", async () => identities.list());
    app.get("/users/:id", async (req) => (await identities.get(req.params.id)) ??
        fail(404, "NOT_FOUND", "User not found"));
    app.post("/users", async (req, reply) => {
        const data = z
            .object({
            name: z.string().min(2).max(100),
            email: z.string().email(),
            password: z.string().min(12).max(128),
            role: z
                .enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"])
                .default("USER"),
        })
            .strict()
            .parse(req.body);
        return reply.code(201).send(await users.create(req.user.id, data));
    });
    app.patch("/users/:id", async (req) => {
        const data = z
            .object({
            name: z.string().min(2).max(100).optional(),
            role: z.enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"]).optional(),
        })
            .strict()
            .parse(req.body);
        return users.update(req.user.id, req.params.id, data);
    });
    app.delete("/users/:id", async (req, reply) => {
        await users.delete(req.user.id, req.params.id);
        return reply.code(204).send();
    });
}
