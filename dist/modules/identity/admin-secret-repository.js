import { prisma } from "../../lib/database.js";
export const adminSecrets = {
    findByEmail(email) {
        return prisma.user.findUnique({
            where: { email },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                status: true,
                emailVerified: true,
                passwordChangeRequired: true,
                termsAcceptedAt: true,
                termsVersion: true,
                createdAt: true,
                adminSecretHash: true,
            },
        });
    },
    authenticationState(tx, userId) {
        return tx.user.findUnique({
            where: { id: userId },
            select: {
                role: true,
                status: true,
                emailVerified: true,
                adminSecretHash: true,
            },
        });
    },
    createSession(tx, userId, token, ipAddress, expiresAt) {
        return tx.session.create({
            data: { userId, token, ipAddress, userAgent: "", expiresAt },
        });
    },
};
