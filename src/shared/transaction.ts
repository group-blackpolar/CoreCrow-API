import { prisma, Prisma } from "../lib/database.js";
export type Transaction = Prisma.TransactionClient;
// Serialize membership changes and commercial transitions; retry serialization conflicts.
export async function transaction<T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}
