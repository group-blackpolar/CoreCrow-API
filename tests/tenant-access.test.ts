import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED = ["modules/authorization/tenant-access.ts", "modules/security-access/enforcement.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

test("the organization network rules are reached only through tenantAccess (RM-021, R-006)", () => {
  const offenders = sourceFiles(SRC)
    .map((file) => relative(SRC, file).split(sep).join("/"))
    .filter((file) => !ALLOWED.includes(file))
    .filter((file) => /\bassertNetworkAllowed\b/.test(readFileSync(join(SRC, file), "utf8")));
  assert.deepEqual(offenders, [], "Use tenantAccess.admit / tenantAccess.member instead of calling the enforcement directly");
});
