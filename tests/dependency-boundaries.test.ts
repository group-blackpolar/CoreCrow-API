import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RM-024: executable dependency rules. The runtime import graph between source areas (src/modules/<name>, src/routes, ...)
 * is compared with tests/dependency-baseline.json, the list of couplings that exist today.
 *  - A coupling that is not in the baseline fails the build: new acoplamientos need a design decision, not a silent import.
 *  - A baseline entry that no longer exists also fails: remove it, so the list can only shrink.
 * Type-only imports are ignored. Everyone may depend on `lib` and `shared` (the platform layer).
 * First creation of the baseline only: DEPENDENCY_BASELINE_INIT=1 npx tsx --test tests/dependency-boundaries.test.ts
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BASELINE = fileURLToPath(new URL("./dependency-baseline.json", import.meta.url));
const PLATFORM = new Set(["lib", "shared"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}
function areaOf(path: string) {
  const parts = relative(SRC, path).split(sep);
  return parts[0] === "modules" && parts.length > 2 ? `modules/${parts[1]}` : parts[0]!.replace(/\.ts$/, "");
}
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s+["'](\.[^"']+)["']|\bimport\(\s*["'](\.[^"']+)["']\s*\)|(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g;

function currentEdges() {
  const edges = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const from = areaOf(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      const target = relative(SRC, resolve(dirname(file), specifier));
      if (target.startsWith("..")) continue;
      const to = areaOf(join(SRC, target));
      if (to !== from && !PLATFORM.has(to)) edges.add(`${from} -> ${to}`);
    }
  }
  return [...edges].sort();
}

test("source areas only depend on each other as listed in the baseline, and the list can only shrink", () => {
  const current = currentEdges();
  if (process.env.DEPENDENCY_BASELINE_INIT === "1") writeFileSync(BASELINE, JSON.stringify({ edges: current }, null, 2) + "\n");
  const baseline = new Set<string>((JSON.parse(readFileSync(BASELINE, "utf8")) as { edges: string[] }).edges);
  const added = current.filter((edge) => !baseline.has(edge));
  const removed = [...baseline].filter((edge) => !current.includes(edge));
  assert.deepEqual(added, [], `New cross-area imports (not allowed without a design decision):\n${added.join("\n")}`);
  assert.deepEqual(removed, [], `These couplings are gone: delete them from tests/dependency-baseline.json so the list only shrinks:\n${removed.join("\n")}`);
});
