import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { stdio: "inherit" });
cpSync("src/public", "dist/public", { recursive: true });
cpSync("src/modules/north/data/import-analysis-child.mjs", "dist/modules/north/data/import-analysis-child.mjs");
cpSync("src/modules/north/data/xlsx-stream-reader.mjs", "dist/modules/north/data/xlsx-stream-reader.mjs");
