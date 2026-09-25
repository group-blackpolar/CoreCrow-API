export const emailVerificationRepository = {
    userByEmail(tx, email) {
        return tx.user.findUnique({
            where: { email },
            select: { id: true, email: true, name: true, emailVerified: true },
        });
    },
    challengeByUser(tx, userId) {
        return tx.emailVerificationChallenge.findUnique({ where: { userId } });
    },
    replaceChallenge(tx, input) {
        return tx.emailVerificationChallenge.upsert({
            where: { userId: input.userId },
            create: input,
            update: {
                codeHash: input.codeHash,
                attempts: 0,
                expiresAt: input.expiresAt,
                createdAt: new Date(),
            },
        });
    },
    incrementAttempts(tx, id) {
        return tx.emailVerificationChallenge.update({
            where: { id },
            data: { attempts: { increment: 1 } },
        });
    },
    deleteChallenge(tx, id) {
        return tx.emailVerificationChallenge.delete({ where: { id } });
    },
    verifyUser(tx, userId) {
        return tx.user.update({
            where: { id: userId },
            data: { emailVerified: true },
            select: { id: true },
        });
    },
};
