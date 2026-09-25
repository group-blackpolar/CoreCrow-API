import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
  bootstrapOperator,
  closeBootstrap,
} from "../src/modules/identity/bootstrap.js";
class SecretOutput extends Writable {
  muted = false;

  _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

const output = new SecretOutput();
const prompt = createInterface({
  input: process.stdin,
  output,
  terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});

async function readInputs() {
  const configuredEmail = process.env.CORECROW_BOOTSTRAP_EMAIL;
  const configuredSecret = process.env.CORECROW_ADMIN_SECRET;
  const configuredPassword = process.env.CORECROW_TEMPORARY_PASSWORD;
  if (
    (!configuredEmail || !configuredSecret || !configuredPassword) &&
    !process.stdin.isTTY
  )
    throw new Error(
      "Non-interactive bootstrap requires CORECROW_BOOTSTRAP_EMAIL, CORECROW_ADMIN_SECRET, and CORECROW_TEMPORARY_PASSWORD",
    );

  const email = configuredEmail ??
    await prompt.question("Verified Better Auth identity email: ");
  let adminSecret = configuredSecret;
  if (!adminSecret) {
    process.stdout.write("Permanent admin secret (input hidden): ");
    output.muted = true;
    adminSecret = await prompt.question("");
    output.muted = false;
    process.stdout.write("\n");
  }
  let temporaryPassword = configuredPassword;
  if (!temporaryPassword) {
    process.stdout.write("Temporary account password (input hidden): ");
    output.muted = true;
    temporaryPassword = await prompt.question("");
    output.muted = false;
    process.stdout.write("\n");
  }

  delete process.env.CORECROW_BOOTSTRAP_EMAIL;
  delete process.env.CORECROW_ADMIN_SECRET;
  delete process.env.CORECROW_TEMPORARY_PASSWORD;
  return {
    email: z.string().trim().email().max(254).parse(email),
    adminSecret: z.string().min(12).max(256).parse(adminSecret),
    temporaryPassword: z.string().min(12).max(128).parse(temporaryPassword),
  };
}

try {
  const { email, adminSecret, temporaryPassword } = await readInputs();
  const result = await bootstrapOperator(
    email,
    adminSecret,
    temporaryPassword,
  );
  console.log(
    `Operator configured (${result.id}). A password change is required and existing sessions were revoked.`,
  );
} catch (error) {
  output.muted = false;
  console.error(error instanceof Error ? error.message : "Bootstrap failed");
  process.exitCode = 1;
} finally {
  prompt.close();
  await closeBootstrap();
}
