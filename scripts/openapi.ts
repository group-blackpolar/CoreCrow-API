import { writeFileSync } from "node:fs";
import { buildApp } from "../src/app.js";
const app = await buildApp({ logger: false });
await app.ready();
writeFileSync("openapi.json", JSON.stringify(app.swagger(), null, 2) + "\n");
writeFileSync("openapi.yaml", app.swagger({ yaml: true }));
await app.close();
