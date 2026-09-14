import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], { stdio: "inherit" });
cpSync("src/public", "dist/public", { recursive: true });
