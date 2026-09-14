export const contacts = {
    create(tx, data) {
        return tx.contactRequest.create({
            data,
            select: { id: true, createdAt: true },
        });
    },
    list(tx, limit) {
        return tx.contactRequest.findMany({
            take: limit,
            orderBy: { createdAt: "desc" },
        });
    },
};
