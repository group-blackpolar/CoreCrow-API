import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/database.js";
import { authenticateAdmin } from "../middlewares/authenticateAdmin.js";
import { requireRole } from "../middlewares/requireRole.js";

export async function userRoutes(app: FastifyInstance) {
  // Lista de usuarios — solo admins/superadmins (authenticateAdmin ya valida el rol)
  app.get("/users", { preHandler: [authenticateAdmin, requireRole("ADMIN")] }, async () => {
    return prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  });

  app.get("/users/:id", { preHandler: [authenticateAdmin, requireRole("ADMIN")] }, async (request) => {
    const { id } = request.params as { id: string };
    return prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  });
}
