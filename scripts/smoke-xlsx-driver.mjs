// XLSX pipeline smoke DRIVER. It talks only to an ISOLATED CoreCrow stack (its own PostgreSQL, throwaway accounts and tenant,
// fixture data only) that shares the real private MinIO and ClamAV. It never prints credentials, signed URLs or object keys.
// Orchestrated by scripts/smoke-xlsx-stack.sh. Modes: clean | enqueue | await | blocked | media
import { createHash, randomUUID } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SMTPServer } from "smtp-server";
import * as XLSX from "xlsx";
import { ZipFile } from "yazl";

const API = process.env.SMOKE_API ?? "http://corecrow-smoke-api:4000";
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://smoke.test";
const FIXTURES = process.env.SMOKE_FIXTURES ?? "/fixtures";
const STATE = process.env.SMOKE_STATE ?? "/state/state.json";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const password = "Smoke-throwaway-Pass-123!";
const prefix = randomUUID().slice(0, 8);
const results = [];
const mail = [];

const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.info(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }));

const smtp = new SMTPServer({
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, _session, done) { let text = ""; stream.on("data", (chunk) => { text += chunk; }); stream.on("end", () => { mail.push(text); done(); }); },
});
await new Promise((resolve) => smtp.listen(5525, "0.0.0.0", resolve));

async function http(method, path, { cookie, body, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, setCookie: response.headers.getSetCookie?.() ?? [] };
}

async function account(label) {
  const email = `${prefix}-${label}@smoke.test`;
  const before = mail.length;
  const up = await http("POST", "/v1/auth/sign-up/email", { body: { email, password, name: label } });
  if (up.status !== 200) throw new Error(`signup ${label} -> ${up.status}`);
  for (let i = 0; i < 40 && mail.length === before; i++) await sleep(250);
  const code = mail.at(-1)?.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
  if (!code) throw new Error("verification code not received");
  const verified = await http("POST", "/v1/identity/verification/confirm", { body: { email, code } });
  if (verified.status !== 200) throw new Error(`verify ${label} -> ${verified.status}`);
  const login = await http("POST", "/v1/auth/sign-in/email", { body: { email, password } });
  if (login.status !== 200) throw new Error(`login ${label} -> ${login.status}`);
  return { email, cookie: login.setCookie.map((c) => c.split(";")[0]).join("; ") };
}

const sheetBytes = (rows, { formula = false } = {}) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (formula) sheet.B2 = { t: "n", f: "A2+1", v: 2 };
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "Data");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
};

async function prepare(who, orgId, datasetId, bytes, { filename = "smoke.xlsx", mime = XLSX_MIME } = {}) {
  const prepared = await http("POST", `/v1/organizations/${orgId}/datasets/${datasetId}/imports`, {
    cookie: who.cookie, headers: { "idempotency-key": randomUUID().replaceAll("-", "") },
    body: { filename, mime, size: bytes.byteLength, checksum: sha(bytes) },
  });
  if (prepared.status !== 201) throw new Error(`prepare -> ${prepared.status} ${prepared.json?.error?.code ?? ""}`);
  const { upload } = prepared.json;
  const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: bytes });
  if (!put.ok) throw new Error(`upload to object storage -> ${put.status}`);
  lastUpload = upload;
  return prepared.json.import.id;
}
let lastUpload = null;
const zipOf = (entries) => new Promise((resolve) => {
  const zip = new ZipFile(); const chunks = [];
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.outputStream.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks)));
  zip.end();
});
const confirmImport = (who, orgId, datasetId, importId) => http("POST", `/v1/organizations/${orgId}/datasets/${datasetId}/imports/${importId}/confirm`, { cookie: who.cookie });
const readImport = async (who, orgId, datasetId, importId) => (await http("GET", `/v1/organizations/${orgId}/datasets/${datasetId}/imports/${importId}`, { cookie: who.cookie })).json;

async function waitFor(who, orgId, datasetId, importId, accept, { timeoutMs = 180_000, label = "" } = {}) {
  const seen = []; const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await readImport(who, orgId, datasetId, importId);
    const mark = `${current.status}/${current.scanStatus}`;
    if (seen.at(-1) !== mark) seen.push(mark);
    if (accept(current)) return { current, seen };
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label || "state"}; saw ${seen.join(" > ")}`);
    await sleep(1_000);
  }
}
const terminal = new Set(["SECURITY_BLOCKED", "ANALYSIS_BLOCKED", "REJECTED", "FAILED", "CANCELLED"]);

async function world() {
  const fixture = readFileSync(`${FIXTURES}/shark-test-data.xlsx`);
  const expected = JSON.parse(readFileSync(`${FIXTURES}/shark-test-data.expected.json`, "utf8"));
  if (sha(fixture) !== expected.sha256) throw new Error("fixture checksum differs from its manifest");
  const state = loadState();
  if (state.owner) return { fixture, expected, ...state };
  const owner = await account("owner"); const outsider = await account("outsider");
  const org = await http("POST", "/v1/organizations", { cookie: owner.cookie, body: { name: `Smoke ${prefix}` } });
  const otherOrg = await http("POST", "/v1/organizations", { cookie: outsider.cookie, body: { name: `Other ${prefix}` } });
  const dataset = await http("POST", `/v1/organizations/${org.json.id}/datasets`, { cookie: owner.cookie, body: { name: { es: "Shark prueba", en: "Shark test" }, slug: `shark-${prefix}` } });
  if (dataset.status !== 201) throw new Error(`dataset -> ${dataset.status}`);
  saveState({ owner, outsider, orgId: org.json.id, otherOrgId: otherOrg.json.id, datasetId: dataset.json.id });
  return { fixture, expected, ...loadState() };
}

async function mapAndActivate(w, importId, columns) {
  const mapping = await http("POST", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/imports/${importId}/mappings`, { cookie: w.owner.cookie, body: { sheetOrdinal: 0, headerRow: 1, columns } });
  if (mapping.status !== 201) throw new Error(`mapping -> ${mapping.status} ${mapping.json?.error?.code ?? ""}`);
  const activated = await http("POST", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/imports/${importId}/activate`, { cookie: w.owner.cookie, body: { mappingId: mapping.json.id, mode: "REPLACE_DATASET" } });
  if (activated.status !== 202) throw new Error(`activate -> ${activated.status} ${activated.json?.error?.code ?? ""}`);
  return waitFor(w.owner, w.orgId, w.datasetId, importId, (c) => c.status === "SUCCEEDED" || terminal.has(c.status), { label: "activation" });
}

const typeMap = { year: "INTEGER", month: "INTEGER", port: "TEXT", carrier: "TEXT", consignee: "TEXT", country: "TEXT", containers: "INTEGER", teus: "INTEGER" };
const createColumns = (analysisColumns) => analysisColumns.map((column) => ({
  sourceOrdinal: column.ordinal, action: "CREATE", key: column.header, displayName: { es: column.header, en: column.header },
  canonicalType: typeMap[column.header], ...(column.header === "consignee" ? { nullable: true } : {}),
}));

async function query(w, body) { const r = await http("POST", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/query`, { cookie: w.owner.cookie, body }); return r; }

async function modeClean() {
  const w = await world();
  const importId = await prepare(w.owner, w.orgId, w.datasetId, w.fixture, { filename: "shark-test-data.xlsx" });
  record("upload to private versioned storage via signed URL", true, `sha256 ${w.expected.sha256.slice(0, 12)}…`);
  const confirmed = await confirmImport(w.owner, w.orgId, w.datasetId, importId);
  record("confirm queues fail-closed security checks (202)", confirmed.status === 202, String(confirmed.status));
  // The signed upload is bound to the declared checksum: replaying it with different bytes must not be accepted.
  const tampered = Buffer.from(w.fixture); tampered[tampered.length - 1] ^= 0xff; // same length, different content
  const replay = await fetch(lastUpload.url, { method: lastUpload.method, headers: lastUpload.headers, body: tampered }).catch((error) => ({ ok: false, status: `network error: ${error.cause?.code ?? error.message}` }));
  record("replaying the signed upload with different bytes is refused by object storage", !replay.ok, `HTTP ${replay.status}`);
  const analyzed = await waitFor(w.owner, w.orgId, w.datasetId, importId, (c) => c.status === "AWAITING_MAPPING" || terminal.has(c.status), { label: "analysis" });
  record("pipeline reaches AWAITING_MAPPING (ClamAV approved, OOXML valid, analysed)", analyzed.current.status === "AWAITING_MAPPING" && analyzed.current.scanStatus === "APPROVED", analyzed.seen.join(" > "));
  const analysis = await http("GET", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/imports/${importId}/analysis`, { cookie: w.owner.cookie });
  const sheet = analysis.json.workbook.sheets[0];
  record("analysis matches the fixture (sheet, rows, columns)", sheet.name === w.expected.sheet && sheet.rowCount === w.expected.rowCount + 1 /* header row */ && sheet.columns.map((c) => c.header).join() === w.expected.columns.join(), `${sheet.rowCount} rows incl. header`);
  const done = await mapAndActivate(w, importId, createColumns(sheet.columns));
  record("mapping + activation materialize an immutable revision", done.current.status === "SUCCEEDED", done.seen.join(" > "));

  const fields = (await http("GET", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/fields`, { cookie: w.owner.cookie })).json;
  const id = Object.fromEntries(fields.map((f) => [f.key, f.id]));
  const total = await query(w, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "rows" }, { operation: "SUM", fieldId: id.containers, alias: "containers" }, { operation: "SUM", fieldId: id.teus, alias: "teus" }] });
  const row = total.json?.rows?.[0];
  const v = (key) => Number(Array.isArray(row) ? row[total.json.columns.findIndex((c) => c.key === key)] : row?.[key]);
  record("query: row count equals the fixture", v("rows") === w.expected.rowCount, `${v("rows")} vs ${w.expected.rowCount}`);
  record("query: SUM(containers) and SUM(teus) equal the fixture", v("containers") === w.expected.totals.containers && v("teus") === w.expected.totals.teus, `${v("containers")}/${v("teus")} vs ${w.expected.totals.containers}/${w.expected.totals.teus}`);
  const byPort = await query(w, { mode: "AGGREGATE", groupBy: [id.port], measures: [{ operation: "SUM", fieldId: id.containers, alias: "containers" }] });
  const cell = (r, key) => (Array.isArray(r) ? r[byPort.json.columns.findIndex((c) => c.key === key)] : r[key]);
  const okPorts = Object.entries(w.expected.byPort).every(([port, e]) => byPort.json.rows.some((r) => cell(r, id.port) === port || cell(r, "port") === port ? Number(cell(r, "containers")) === e.containers : false));
  record("query: GROUP BY port equals the fixture for every port", okPorts, `${byPort.json.rows.length} groups`);
  const filtered = await query(w, { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "rows" }], filters: [{ fieldId: id.year, operator: "EQ", value: 2025 }] });
  const fr = filtered.json?.rows?.[0]; const fv = Number(Array.isArray(fr) ? fr[0] : fr?.rows);
  record("query: declarative filter year=2025 equals the fixture", fv === w.expected.byYear["2025"].rows, `${fv} vs ${w.expected.byYear["2025"].rows}`);

  // Authorization negatives: another tenant learns nothing and cannot read, import or query.
  const denied = await Promise.all([
    http("GET", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}`, { cookie: w.outsider.cookie }),
    http("GET", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/imports/${importId}`, { cookie: w.outsider.cookie }),
    http("POST", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}/query`, { cookie: w.outsider.cookie, body: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "rows" }] } }),
    http("GET", `/v1/organizations/${w.otherOrgId}/datasets/${w.datasetId}`, { cookie: w.outsider.cookie }),
    http("GET", `/v1/organizations/${w.orgId}/datasets/${w.datasetId}`),
  ]);
  record("other tenant and anonymous callers are denied everywhere", denied.every((r) => [401, 403, 404].includes(r.status) && !JSON.stringify(r.json ?? {}).includes(w.datasetId + "\"")), denied.map((r) => r.status).join(","));

  // Hostile inputs: each must end blocked/rejected and never reach mapping.
  const hostile = async (label, bytes, options) => {
    const dataset = await http("POST", `/v1/organizations/${w.orgId}/datasets`, { cookie: w.owner.cookie, body: { name: { es: label, en: label }, slug: `h-${prefix}-${Math.floor(Math.random() * 1e6)}` } });
    const importId2 = await prepare(w.owner, w.orgId, dataset.json.id, bytes, options);
    await confirmImport(w.owner, w.orgId, dataset.json.id, importId2);
    const result = await waitFor(w.owner, w.orgId, dataset.json.id, importId2, (c) => terminal.has(c.status) || ["AWAITING_MAPPING", "READY_TO_ACTIVATE", "SUCCEEDED"].includes(c.status), { timeoutMs: 120_000, label });
    record(`${label}: blocked fail-closed, never mappable`, terminal.has(result.current.status), `${result.seen.join(" > ")} ${result.current.errorCode ?? ""}`.trim());
  };
  await hostile("workbook with a formula", sheetBytes([["a", "b"], [1, 2]], { formula: true }), { filename: "formula.xlsx" });
  await hostile("plain text declared as XLSX", Buffer.from("this is not a workbook\n".repeat(50)), { filename: "fake.xlsx" });
  const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "ascii");
  await hostile("EICAR test string declared as XLSX", eicar, { filename: "eicar.xlsx" });
  // A ZIP that passes the magic-byte gate but carries the EICAR test file: ClamAV must quarantine it before any parsing.
  const infectedZip = await zipOf([["[Content_Types].xml", Buffer.from("<Types/>")], ["eicar.com", eicar]]);
  {
    const dataset = await http("POST", `/v1/organizations/${w.orgId}/datasets`, { cookie: w.owner.cookie, body: { name: { es: "zip eicar", en: "zip eicar" }, slug: `z-${prefix}` } });
    const zipImport = await prepare(w.owner, w.orgId, dataset.json.id, infectedZip, { filename: "infected.xlsx" });
    await confirmImport(w.owner, w.orgId, dataset.json.id, zipImport);
    const result = await waitFor(w.owner, w.orgId, dataset.json.id, zipImport, (c) => terminal.has(c.status) || c.status === "AWAITING_MAPPING", { timeoutMs: 120_000, label: "infected zip" });
    record("EICAR inside a valid-looking ZIP is quarantined by ClamAV before parsing", result.current.scanStatus === "QUARANTINED" && terminal.has(result.current.status), result.seen.join(" > "));
  }

  // Cancellation: confirm then cancel immediately.
  const cancelDataset = await http("POST", `/v1/organizations/${w.orgId}/datasets`, { cookie: w.owner.cookie, body: { name: { es: "cancelacion", en: "cancel" }, slug: `c-${prefix}` } });
  const cancelId = await prepare(w.owner, w.orgId, cancelDataset.json.id, w.fixture, { filename: "cancel.xlsx" });
  await confirmImport(w.owner, w.orgId, cancelDataset.json.id, cancelId);
  await http("POST", `/v1/organizations/${w.orgId}/datasets/${cancelDataset.json.id}/imports/${cancelId}/cancel`, { cookie: w.owner.cookie });
  const cancelled = await waitFor(w.owner, w.orgId, cancelDataset.json.id, cancelId, (c) => c.status === "CANCELLED" || ["AWAITING_MAPPING", "SUCCEEDED"].includes(c.status), { label: "cancellation" });
  record("cancellation ends in CANCELLED (or finished before the cancel landed)", ["CANCELLED", "AWAITING_MAPPING"].includes(cancelled.current.status), cancelled.seen.join(" > "));
}

async function modeEnqueue() {
  const w = await world();
  const dataset = await http("POST", `/v1/organizations/${w.orgId}/datasets`, { cookie: w.owner.cookie, body: { name: { es: "reinicio", en: "restart" }, slug: `r-${prefix}` } });
  const importId = await prepare(w.owner, w.orgId, dataset.json.id, w.fixture, { filename: "restart.xlsx" });
  const confirmed = await confirmImport(w.owner, w.orgId, dataset.json.id, importId);
  saveState({ restartDatasetId: dataset.json.id, restartImportId: importId });
  await sleep(4_000);
  const current = await readImport(w.owner, w.orgId, dataset.json.id, importId);
  record("with the worker stopped, a confirmed import waits durably (no processing)", confirmed.status === 202 && ["SECURITY_PENDING"].includes(current.status), `${current.status}/${current.scanStatus}`);
}
async function modeAwait() {
  const w = await world();
  const result = await waitFor(w.owner, w.orgId, w.restartDatasetId, w.restartImportId, (c) => c.status === "AWAITING_MAPPING" || terminal.has(c.status), { label: "post-restart processing" });
  record("after the worker restarts the queued import completes security + analysis", result.current.status === "AWAITING_MAPPING", result.seen.join(" > "));
}
async function modeBlocked() {
  const w = await world();
  const dataset = await http("POST", `/v1/organizations/${w.orgId}/datasets`, { cookie: w.owner.cookie, body: { name: { es: "sin clamav", en: "no clamav" }, slug: `b-${prefix}` } });
  const importId = await prepare(w.owner, w.orgId, dataset.json.id, w.fixture, { filename: "blocked.xlsx" });
  await confirmImport(w.owner, w.orgId, dataset.json.id, importId);
  let approved = false; const seen = []; const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const current = await readImport(w.owner, w.orgId, dataset.json.id, importId);
    const mark = `${current.status}/${current.scanStatus}`; if (seen.at(-1) !== mark) seen.push(mark);
    if (current.scanStatus === "APPROVED" || ["AWAITING_MAPPING", "SUCCEEDED", "READY_TO_ACTIVATE"].includes(current.status)) approved = true;
    await sleep(1_000);
  }
  record("with ClamAV stopped the import is never approved (no fallback)", !approved, seen.join(" > "));
  saveState({ blockedDatasetId: dataset.json.id, blockedImportId: importId });
}

// A real, tiny PNG (not just a signature) so the avatar/icon path is exercised with decodable image bytes.
function png(seed) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length); return out; };
  const size = 16; const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 3 + 1); raw[o] = 0; raw.writeUInt8((x * 16 + seed) & 255, o + 1 + x * 3); raw.writeUInt8((y * 16) & 255, o + 2 + x * 3); raw.writeUInt8(seed & 255, o + 3 + x * 3); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
async function putSigned(upload, bytes) { const r = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: bytes }); if (!r.ok) throw new Error(`presigned PUT -> ${r.status}`); }
async function readSigned(download) { const r = await fetch(download.url); if (!r.ok) throw new Error(`presigned GET -> ${r.status}`); return Buffer.from(await r.arrayBuffer()); }

async function modeMedia() {
  const w = await world();
  const first = png(1), second = png(2);
  const request = (bytes) => ({ mime: "image/png", size: bytes.byteLength, checksum: sha(bytes) });
  // Avatar: upload through the public presigned path, confirm (ClamAV), read back the exact bytes, replace, delete.
  const up1 = await http("POST", "/v1/me/avatar/uploads", { cookie: w.owner.cookie, body: request(first) });
  await putSigned(up1.json.upload, first);
  const ready1 = await http("POST", `/v1/me/avatar/${up1.json.avatar.id}/confirm`, { cookie: w.owner.cookie });
  record("avatar: upload via presigned URL, ClamAV scan and READY", up1.status === 201 && ready1.status === 200 && ready1.json.status === "READY", `${up1.status}/${ready1.status}`);
  const read1 = await http("GET", "/v1/me/avatar", { cookie: w.owner.cookie });
  record("avatar: the pinned signed read returns the exact uploaded bytes", sha(await readSigned(read1.json.download)) === sha(first));
  const up2 = await http("POST", "/v1/me/avatar/uploads", { cookie: w.owner.cookie, body: request(second) });
  await putSigned(up2.json.upload, second);
  await http("POST", `/v1/me/avatar/${up2.json.avatar.id}/confirm`, { cookie: w.owner.cookie });
  const read2 = await http("GET", "/v1/me/avatar", { cookie: w.owner.cookie });
  record("avatar: replacing keeps one live avatar and serves the new bytes", read2.json.avatar.id === up2.json.avatar.id && sha(await readSigned(read2.json.download)) === sha(second));
  const other = await http("GET", "/v1/me/avatar", { cookie: w.outsider.cookie });
  record("avatar: another user sees no avatar of yours", other.status === 200 && other.json.avatar === null);
  const del = await http("DELETE", "/v1/me/avatar", { cookie: w.owner.cookie });
  const gone = await http("GET", "/v1/me/avatar", { cookie: w.owner.cookie });
  record("avatar: delete removes it", del.status === 200 && gone.json.avatar === null);

  // Organization icon: asset -> reference -> member read; tenant and in-use protections.
  const iconBytes = png(3);
  const asset = await http("POST", `/v1/organizations/${w.orgId}/assets/uploads`, { cookie: w.owner.cookie, body: { filename: "icon.png", ...request(iconBytes) } });
  await putSigned(asset.json.upload, iconBytes);
  const confirmed = await http("POST", `/v1/organizations/${w.orgId}/assets/${asset.json.asset.id}/confirm`, { cookie: w.owner.cookie });
  record("org icon: asset uploaded via presigned URL and scanned READY", confirmed.status === 200 && confirmed.json.status === "READY", String(confirmed.status));
  const linked = await http("PATCH", `/v1/organizations/${w.orgId}`, { cookie: w.owner.cookie, body: { iconAssetId: asset.json.asset.id } });
  const iconRead = await http("GET", `/v1/organizations/${w.orgId}/icon`, { cookie: w.owner.cookie });
  record("org icon: linked and served as the exact uploaded bytes", linked.status === 200 && sha(await readSigned(iconRead.json.download)) === sha(iconBytes));
  const foreign = await http("PATCH", `/v1/organizations/${w.orgId}`, { cookie: w.outsider.cookie, body: { iconAssetId: asset.json.asset.id } });
  const foreignRead = await http("GET", `/v1/organizations/${w.orgId}/icon`, { cookie: w.outsider.cookie });
  record("org icon: another tenant can neither change nor read it", [403, 404].includes(foreign.status) && [403, 404].includes(foreignRead.status), `${foreign.status}/${foreignRead.status}`);
  const inUse = await http("DELETE", `/v1/organizations/${w.orgId}/assets/${asset.json.asset.id}`, { cookie: w.owner.cookie });
  record("org icon: the asset in use cannot be deleted", inUse.status === 409, String(inUse.status));
  const infected = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "ascii");
  const bad = await http("POST", "/v1/me/avatar/uploads", { cookie: w.owner.cookie, body: { mime: "image/png", size: infected.byteLength, checksum: sha(infected) } });
  await putSigned(bad.json.upload, infected);
  const badConfirm = await http("POST", `/v1/me/avatar/${bad.json.avatar.id}/confirm`, { cookie: w.owner.cookie });
  const none = await http("GET", "/v1/me/avatar", { cookie: w.owner.cookie });
  record("avatar: a non-image or infected upload never becomes READY", badConfirm.status >= 400 && none.json.avatar === null, String(badConfirm.status));
}

const mode = process.argv[2] ?? "clean";
try {
  await { clean: modeClean, enqueue: modeEnqueue, await: modeAwait, blocked: modeBlocked, media: modeMedia }[mode]();
} catch (error) {
  record(`${mode}: unexpected failure`, false, String(error.message ?? error));
}
smtp.close();
const failed = results.filter((r) => !r.ok).length;
console.info(`\n${mode}: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
