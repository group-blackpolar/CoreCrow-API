import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
  bootstrapOperator,
  closeBootstrap,
} from "../src/modules/identity/bootstrap.js";
const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});
try {
  const email = z
    .string()
    .email()
    .parse(
      (
        await prompt.question(
          "Email of the verified Better Auth identity to bootstrap: ",
        )
      ).trim(),
    );
  const result = await bootstrapOperator(email);
  console.log(
    `Operator initialized (${result.id}). Sign in again using Better Auth.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Bootstrap failed");
  process.exitCode = 1;
} finally {
  prompt.close();
  await closeBootstrap();
}
