import { prisma, Prisma } from "../lib/database.js";
export type Transaction = Prisma.TransactionClient;
// Serialize membership changes and commercial transitions; retry serialization conflicts.
export async function transaction<T>(
  work: (tx: Transaction) => Promise<T>,
  options: { retries?: number; timeoutMilliseconds?: number; isolationLevel?: "Serializable" | "ReadCommitted" } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: options.isolationLevel ?? "Serializable",
        ...(options.timeoutMilliseconds ? { timeout: options.timeoutMilliseconds, maxWait: 10_000 } : {}),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < retries
      ) {
        // Jitter keeps contending writers (for example the document counter) from colliding in lockstep.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}
