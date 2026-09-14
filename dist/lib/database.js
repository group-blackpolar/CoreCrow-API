import { PrismaClient } from "@prisma/client";
const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma ??
    new PrismaClient({
        log: [], // Never log SQL or database exceptions containing identity or connection data.
    });
if (process.env.NODE_ENV !== "production")
    globalForPrisma.prisma = prisma;
export * from "@prisma/client";
