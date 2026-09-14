import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
test("HTTP route adapters never access Prisma or execute SQL", () => {
  for (const file of readdirSync(new URL("../src/routes/", import.meta.url))) {
    const source = readFileSync(
      new URL(`../src/routes/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /@prisma\/client|lib\/database|\$queryRaw|\$executeRaw|prisma\./,
      file,
    );
  }
});
