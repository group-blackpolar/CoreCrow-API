import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RM-026: every Prisma model has one owning area; any other area touching it is an exception listed in
 * tests/table-ownership-baseline.json. A new cross-area access fails the build and a stale exception fails too,
 * so the list can only shrink. A new model must be given an owner in the baseline.
 * First creation / owner changes only: TABLE_OWNERSHIP_INIT=1 npx tsx --test tests/table-ownership.test.ts
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const BASELINE = fileURLToPath(new URL("./table-ownership-baseline.json", import.meta.url));
/** Intended owners where today's usage points elsewhere or nowhere (the access is then an exception to retire). */
const INTENDED: Record<string, string> = {
  Organization: "tenancy", Membership: "tenancy", Invoice: "commerce", DocumentAttachmentBlob: "documents", DocumentSequence: "documents",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}
function areaOf(file: string) {
  const parts = relative(SRC, file).split(sep);
  return parts[0] === "modules" && parts.length > 2 ? parts[1]! : parts[0]!.replace(/\.ts$/, "");
}
function usage() {
  const models = [...readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!);
  const used = new Map<string, Map<string, number>>(models.map((model) => [model, new Map()]));
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const area = areaOf(file);
    for (const model of models) {
      const hits = text.match(new RegExp(String.raw`\b(?:tx|prisma|db|client)\.${model[0]!.toLowerCase()}${model.slice(1)}\b`, "g"))?.length ?? 0;
      if (hits) used.get(model)!.set(area, (used.get(model)!.get(area) ?? 0) + hits);
    }
  }
  return used;
}

test("every table has one owning area; other areas touching it are listed exceptions that can only shrink (RM-026)", () => {
  const used = usage();
  if (process.env.TABLE_OWNERSHIP_INIT === "1") {
    const owners: Record<string, string> = {};
    for (const [model, areas] of used) owners[model] = INTENDED[model] ?? [...areas].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unused";
    const exceptions = [...used].flatMap(([model, areas]) => [...areas.keys()].filter((area) => area !== owners[model]).map((area) => `${area}:${model}`)).sort();
    writeFileSync(BASELINE, JSON.stringify({ owners, exceptions }, null, 2) + "\n");
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { owners: Record<string, string>; exceptions: string[] };
  const unowned = [...used.keys()].filter((model) => !baseline.owners[model]);
  assert.deepEqual(unowned, [], "New models need an owner in tests/table-ownership-baseline.json");
  const current = [...used].flatMap(([model, areas]) => [...areas.keys()].filter((area) => area !== baseline.owners[model]).map((area) => `${area}:${model}`)).sort();
  const known = new Set(baseline.exceptions);
  const added = current.filter((pair) => !known.has(pair));
  const removed = baseline.exceptions.filter((pair) => !current.includes(pair));
  assert.deepEqual(added, [], `An area now reads or writes a table it does not own; go through the owner's repository:\n${added.join("\n")}`);
  assert.deepEqual(removed, [], `These accesses are gone: delete them from tests/table-ownership-baseline.json so the list only shrinks:\n${removed.join("\n")}`);
});
