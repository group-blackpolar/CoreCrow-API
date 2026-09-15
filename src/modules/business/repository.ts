import type { Transaction } from "../../shared/transaction.js";
export const contacts = {
  create(
    tx: Transaction,
    data: {
      name: string;
      email: string;
      organization: string;
      country: string;
      project: string;
      message: string;
      locale: string;
    },
  ) {
    return tx.contactRequest.create({
      data: {
        ...data,
        notificationStatus: "pending",
        notificationNextAttemptAt: new Date(),
      },
      select: { id: true, createdAt: true },
    });
  },
  list(tx: Transaction, limit: number) {
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
