export const contacts = {
    create(tx, data) {
        return tx.contactRequest.create({
            data: {
                ...data,
                notificationStatus: "pending",
                notificationNextAttemptAt: new Date(),
            },
            select: { id: true, createdAt: true },
        });
    },
    list(tx, limit) {
        return tx.contactRequest.findMany({
            take: limit,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                name: true,
                email: true,
                organization: true,
                country: true,
                project: true,
                message: true,
                locale: true,
                consentAt: true,
                createdAt: true,
            },
        });
    },
};
