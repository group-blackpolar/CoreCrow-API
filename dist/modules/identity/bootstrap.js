import { prisma } from "../../lib/database.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { fail } from "../../shared/errors.js";
export async function bootstrapOperator(email) {
    return transaction(async (tx) => {
        if (await tx.user.count({ where: { role: "SUPERADMIN" } }))
            fail(409, "ALREADY_INITIALIZED", "A superadmin already exists; use the authenticated role-management API");
        const user = await tx.user.findUnique({
            where: { email: email.toLowerCase() },
        });
        if (!user?.emailVerified)
            fail(409, "VERIFIED_IDENTITY_REQUIRED", "Register and verify this identity through Better Auth first");
        if (!await tx.account.findFirst({ where: { userId: user.id } }))
            fail(409, "CREDENTIAL_REQUIRED", "Enroll a Better Auth credential before promoting this identity");
        await tx.user.update({
            where: { id: user.id },
            data: { role: "SUPERADMIN", adminUniqueId: null },
        });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await auditRepository.append(tx, {
            actorId: user.id,
            action: "identity.operator.bootstrap",
            targetId: user.id,
        });
        return { id: user.id };
    });
}
export const closeBootstrap = () => prisma.$disconnect();
