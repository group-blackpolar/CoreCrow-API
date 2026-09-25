export const billingRepository = {
    profile(tx, organizationId) {
        return tx.organizationBillingProfile.findUnique({
            where: { organizationId },
            include: { organization: { select: { status: true } } },
        });
    },
    billableMembers(tx, organizationId) {
        return tx.membership.count({
            where: { organizationId, user: { status: "ACTIVE" } },
        });
    },
    updateEmail(tx, organizationId, billingEmail) {
        return tx.organizationBillingProfile.update({
            where: { organizationId },
            data: { billingEmail },
        });
    },
    updateStatus(tx, organizationId, status) {
        return tx.organizationBillingProfile.update({
            where: { organizationId },
            data: { status },
        });
    },
    statusCounts(tx) {
        return tx.organizationBillingProfile.groupBy({
            by: ["status"],
            _count: { _all: true },
            orderBy: { status: "asc" },
        });
    },
    eligibleProfileCount(tx) {
        return tx.organizationBillingProfile.count({
            where: {
                status: { not: "CLOSED" },
                organization: { status: "ACTIVE" },
            },
        });
    },
    totalBillableMembers(tx) {
        return tx.membership.count({
            where: {
                user: { status: "ACTIVE" },
                organization: {
                    status: "ACTIVE",
                    billingProfile: { status: { not: "CLOSED" } },
                },
            },
        });
    },
};
