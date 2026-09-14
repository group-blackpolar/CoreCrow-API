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
      data,
      select: { id: true, createdAt: true },
    });
  },
  list(tx: Transaction, limit: number) {
    return tx.contactRequest.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
    });
  },
};
