import { prisma } from "../../lib/database.js";
export async function dependencyChecks() {
    const checks = {
        Identity: () => prisma.user.findFirst({ select: { id: true } }),
        Authorization: () => prisma.membership.findFirst({ select: { id: true } }),
        "Multi-tenancy": () => prisma.organization.findFirst({ select: { id: true } }),
        Audit: () => prisma.auditLog.findFirst({ select: { id: true } }),
        Security: () => prisma.session.findFirst({ select: { id: true } }),
        Commerce: () => prisma.product.findFirst({ select: { id: true } }),
        "Business services": () => prisma.contactRequest.findFirst({ select: { id: true } }),
    };
    return Promise.all(Object.entries(checks).map(async ([name, check]) => {
        try {
            await check();
            return { name, status: "available" };
        }
        catch {
            return { name, status: "unavailable" };
        }
    }));
}
