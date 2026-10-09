import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import {
  ClamAvInstreamError,
  clamAvConfigurationFromEnvironment,
  scanClamAvInstream,
  type ClamAvInstreamConfiguration,
} from "../src/infrastructure/clamav.js";
import { ClamAvMalwareScanner, UnconfiguredMalwareScanner, malwareScannerFromEnvironment } from "../src/modules/north/malware-scanner.js";
import { ClamAvDatasetImportMalwareScanner, UnconfiguredDatasetImportMalwareScanner, datasetImportMalwareScannerFromEnvironment } from "../src/modules/north/data/import-malware-scanner.js";
import { FakeObjectStorage } from "../src/infrastructure/object-storage.js";

type Mode = "clean" | "infected" | "clamd-error" | "garbage" | "huge-reply" | "silent" | "drop-after-first-chunk" | "no-terminator";
type Fake = { port: number; close(): Promise<void>; connections: number; received: Buffer[]; payload(): Buffer; framing(): { header: string; chunkSizes: number[]; terminated: boolean } };

async function fakeClamd(mode: Mode, options: { pauseReadingMs?: number } = {}): Promise<Fake> {
  const state = { connections: 0, received: [] as Buffer[] };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (options.pauseReadingMs) { socket.pause(); setTimeout(() => socket.resume(), options.pauseReadingMs); }
    let reply = false;
    socket.on("data", (data) => {
      state.received.push(data);
      if (mode === "drop-after-first-chunk" && Buffer.concat(state.received).length > 20) { socket.destroy(); return; }
      const all = Buffer.concat(state.received);
      const ended = all.length >= 4 && all.subarray(all.length - 4).equals(Buffer.alloc(4)) && all.includes(Buffer.from("zINSTREAM\0"));
      if (!ended || reply) return;
      reply = true;
      const answer = { clean: "stream: OK\0", infected: "stream: Eicar-Test-Signature FOUND\0", "clamd-error": "INSTREAM size limit exceeded. ERROR\0", garbage: "hello\0", "no-terminator": "stream: OK", silent: "", "huge-reply": `${"x".repeat(10_000)}\0`, "drop-after-first-chunk": "" }[mode];
      if (mode === "no-terminator") { socket.end(answer); return; }
      if (answer) socket.write(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get connections() { return state.connections; },
    received: state.received,
    payload() {
      const all = Buffer.concat(state.received).subarray("zINSTREAM\0".length);
      const out: Buffer[] = [];
      for (let offset = 0; offset + 4 <= all.length;) {
        const size = all.readUInt32BE(offset);
        if (size === 0) break;
        out.push(all.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
      return Buffer.concat(out);
    },
    framing() {
      const all = Buffer.concat(state.received);
      const chunkSizes: number[] = [];
      let offset = "zINSTREAM\0".length;
      while (offset + 4 <= all.length) { const size = all.readUInt32BE(offset); if (size === 0) break; chunkSizes.push(size); offset += 4 + size; }
      return { header: all.subarray(0, "zINSTREAM\0".length).toString("latin1"), chunkSizes, terminated: all.length >= offset + 4 && all.readUInt32BE(offset) === 0 };
    },
    close: () => new Promise<void>((resolve) => { sockets.forEach((socket) => socket.destroy()); server.close(() => resolve()); }),
  };
}

const configuration = (port: number, overrides: Partial<ClamAvInstreamConfiguration> = {}): ClamAvInstreamConfiguration => ({
  endpoint: { host: "127.0.0.1", port }, timeoutMilliseconds: 2_000, deadlineMilliseconds: 10_000, maximumBytes: 50 * 1024 * 1024, chunkBytes: 1024, ...overrides,
});
const bytes = (size: number) => Buffer.alloc(size, 0x61);
const open = (data: Buffer, parts = 1) => async () => Readable.from(Array.from({ length: parts }, (_, i) => data.subarray(Math.floor((data.length * i) / parts), Math.floor((data.length * (i + 1)) / parts))));
const scan = (port: number, data: Buffer, overrides: Partial<ClamAvInstreamConfiguration> = {}, signal = new AbortController().signal) =>
  scanClamAvInstream(configuration(port, overrides), { size: data.length, openPrivateRead: open(data, 3), signal });
const kind = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error) => (error instanceof ClamAvInstreamError ? error.kind : (error as Error).name));

test("clean object: strict INSTREAM framing, bounded chunks, payload intact", async () => {
  const clamd = await fakeClamd("clean");
  try {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    assert.equal(await scan(clamd.port, data), "CLEAN");
    const framing = clamd.framing();
    assert.equal(framing.header, "zINSTREAM\0");
    assert.ok(framing.chunkSizes.every((size) => size > 0 && size <= 1024));
    assert.equal(framing.terminated, true);
    assert.ok(clamd.payload().equals(data), "the exact bytes reach clamd");
  } finally { await clamd.close(); }
});

test("infected object is reported as INFECTED", async () => {
  const clamd = await fakeClamd("infected");
  try { assert.equal(await scan(clamd.port, bytes(100)), "INFECTED"); } finally { await clamd.close(); }
});

test("anything other than OK or FOUND fails closed: clamd ERROR, garbage, oversized or unterminated replies", async () => {
  for (const mode of ["clamd-error", "garbage", "huge-reply", "no-terminator"] as const) {
    const clamd = await fakeClamd(mode);
    try { assert.equal(await kind(scan(clamd.port, bytes(100))), "UNAVAILABLE", mode); } finally { await clamd.close(); }
  }
});

test("unavailable: nothing is listening", async () => {
  const clamd = await fakeClamd("clean");
  const port = clamd.port;
  await clamd.close();
  assert.equal(await kind(scan(port, bytes(10))), "UNAVAILABLE");
});

test("connection dropped mid-upload is UNAVAILABLE, never a verdict", async () => {
  const clamd = await fakeClamd("drop-after-first-chunk");
  try { assert.equal(await kind(scan(clamd.port, bytes(200_000), { chunkBytes: 4096 })), "UNAVAILABLE"); } finally { await clamd.close(); }
});

test("idle timeout: a scanner that never answers is UNAVAILABLE within the timeout", async () => {
  const clamd = await fakeClamd("silent");
  try {
    const started = Date.now();
    assert.equal(await kind(scan(clamd.port, bytes(100), { timeoutMilliseconds: 150 })), "UNAVAILABLE");
    assert.ok(Date.now() - started < 3_000);
  } finally { await clamd.close(); }
});

test("wall-clock deadline: a slow trickle cannot hold the scan open indefinitely", async () => {
  const clamd = await fakeClamd("clean");
  try {
    const slow = async () => Readable.from((async function* () { for (let i = 0; i < 100; i++) { await new Promise((resolve) => setTimeout(resolve, 30)); yield bytes(10); } })());
    const started = Date.now();
    const result = await kind(scanClamAvInstream(configuration(clamd.port, { deadlineMilliseconds: 150 }), { size: 1000, openPrivateRead: slow, signal: new AbortController().signal }));
    assert.equal(result, "UNAVAILABLE");
    assert.ok(Date.now() - started < 2_000);
  } finally { await clamd.close(); }
});

test("oversize: declared size above the limit never opens a connection or reads the object", async () => {
  const clamd = await fakeClamd("clean");
  try {
    let opened = false;
    const result = await kind(scanClamAvInstream(configuration(clamd.port, { maximumBytes: 1000 }), { size: 1001, openPrivateRead: async () => { opened = true; return Readable.from([]); }, signal: new AbortController().signal }));
    assert.equal(result, "SIZE_EXCEEDED");
    assert.equal(opened, false);
    assert.equal(clamd.connections, 0);
  } finally { await clamd.close(); }
});

test("size mismatch: more or fewer bytes than declared is rejected, and the terminator is never sent for extra bytes", async () => {
  const clamd = await fakeClamd("clean");
  try {
    const data = bytes(500);
    assert.equal(await kind(scanClamAvInstream(configuration(clamd.port), { size: 400, openPrivateRead: open(data), signal: new AbortController().signal })), "SIZE_MISMATCH");
    assert.equal(await kind(scanClamAvInstream(configuration(clamd.port), { size: 600, openPrivateRead: open(data), signal: new AbortController().signal })), "SIZE_MISMATCH");
  } finally { await clamd.close(); }
});

test("abort mid-stream rejects with the caller's reason and closes the connection", async () => {
  const clamd = await fakeClamd("silent");
  try {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const endless = async () => Readable.from((async function* () { for (;;) { await new Promise((resolve) => setTimeout(resolve, 10)); yield bytes(100); } })());
    const pending = scanClamAvInstream(configuration(clamd.port), { size: 10_000_000, openPrivateRead: endless, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 80);
    await assert.rejects(pending, (error) => error === reason);
    await assert.rejects(scanClamAvInstream(configuration(clamd.port), { size: 10, openPrivateRead: open(bytes(10)), signal: controller.signal }), (error) => error === reason, "already aborted");
  } finally { await clamd.close(); }
});

test("backpressure: a scanner that reads slowly still receives every byte, in order", async () => {
  const clamd = await fakeClamd("clean", { pauseReadingMs: 150 });
  try {
    const data = Buffer.from(Array.from({ length: 6 * 1024 * 1024 }, (_, i) => (i * 31) % 256));
    assert.equal(await scan(clamd.port, data, { chunkBytes: 64 * 1024, timeoutMilliseconds: 5_000 }), "CLEAN");
    assert.ok(clamd.payload().equals(data));
  } finally { await clamd.close(); }
});

test("invalid scanner configuration is rejected before any I/O", async () => {
  for (const bad of [{ timeoutMilliseconds: 0 }, { deadlineMilliseconds: -1 }, { maximumBytes: 0 }, { chunkBytes: 0 }, { chunkBytes: 2 * 1024 * 1024 }]) {
    assert.equal(await kind(scan(9, bytes(10), bad)), "CONFIGURATION_INVALID", JSON.stringify(bad));
  }
});

test("environment: CORECROW_CLAMAV_* wins, legacy import variables still work, MAX can only lower the ceiling", () => {
  assert.equal(clamAvConfigurationFromEnvironment(1000, {}), undefined);
  const legacy = clamAvConfigurationFromEnvironment(1000, { NORTH_DATA_IMPORT_CLAMAV_HOST: "old", NORTH_DATA_IMPORT_CLAMAV_PORT: "3310" })!;
  assert.deepEqual(legacy.endpoint, { host: "old", port: 3310 });
  const modern = clamAvConfigurationFromEnvironment(1000, { CORECROW_CLAMAV_HOST: "new", CORECROW_CLAMAV_PORT: "3311", NORTH_DATA_IMPORT_CLAMAV_HOST: "old", NORTH_DATA_IMPORT_CLAMAV_PORT: "3310", CORECROW_CLAMAV_MAX_BYTES: "5000", CORECROW_CLAMAV_TIMEOUT_MS: "1234" })!;
  assert.deepEqual(modern.endpoint, { host: "new", port: 3311 });
  assert.equal(modern.maximumBytes, 1000, "the shared limit cannot raise the caller's ceiling");
  assert.equal(modern.timeoutMilliseconds, 1234);
  assert.equal(clamAvConfigurationFromEnvironment(1000, { CORECROW_CLAMAV_HOST: "h", CORECROW_CLAMAV_PORT: "1", CORECROW_CLAMAV_MAX_BYTES: "10" })!.maximumBytes, 10);
  assert.throws(() => clamAvConfigurationFromEnvironment(1000, { CORECROW_CLAMAV_SOCKET: "/s", CORECROW_CLAMAV_HOST: "h", CORECROW_CLAMAV_PORT: "1" }), ClamAvInstreamError);
  assert.throws(() => clamAvConfigurationFromEnvironment(1000, { CORECROW_CLAMAV_HOST: "h" }), ClamAvInstreamError);
  assert.throws(() => clamAvConfigurationFromEnvironment(1000, { CORECROW_CLAMAV_HOST: "h", CORECROW_CLAMAV_PORT: "70000" }), ClamAvInstreamError);
});

test("asset scanner: maps verdicts, reads the pinned version, and fails closed", async () => {
  const clamd = await fakeClamd("clean");
  const storage = new FakeObjectStorage();
  const reads: Array<[string, string | undefined]> = [];
  const original = storage.openPrivateRead.bind(storage);
  storage.openPrivateRead = async (key: string, versionId?: string) => { reads.push([key, versionId]); return original(key, versionId); };
  const body = Buffer.from("not-an-image-but-scanned-anyway");
  const version = storage.put("assets/a", { bytes: body, mime: "image/png", checksum: "x" });
  try {
    const scanner = new ClamAvMalwareScanner(storage, configuration(clamd.port));
    const input = { storageKey: "assets/a", storageVersionId: version, mime: "image/png", size: body.length, checksum: "x" };
    assert.equal(await scanner.scan(input), "APPROVED");
    assert.deepEqual(reads, [["assets/a", version]]);
    assert.ok(clamd.payload().equals(body));
    await assert.rejects(new ClamAvMalwareScanner(storage, configuration(clamd.port, { maximumBytes: 5 })).scan(input), { code: "ASSET_SIZE_INVALID", statusCode: 422 });
    await assert.rejects(scanner.scan({ ...input, size: body.length + 1 }), { code: "ASSET_SIZE_MISMATCH", statusCode: 422 });
    await assert.rejects(scanner.scan({ ...input, storageVersionId: "missing-version" }), { code: "MALWARE_SCANNER_UNAVAILABLE", statusCode: 503 });
  } finally { await clamd.close(); }
  const infected = await fakeClamd("infected");
  try { assert.equal(await new ClamAvMalwareScanner(storage, configuration(infected.port)).scan({ storageKey: "assets/a", storageVersionId: version, mime: "image/png", size: body.length, checksum: "x" }), "QUARANTINED"); } finally { await infected.close(); }
  await assert.rejects(new ClamAvMalwareScanner(storage, configuration(1)).scan({ storageKey: "assets/a", storageVersionId: version, mime: "image/png", size: body.length, checksum: "x" }), { code: "MALWARE_SCANNER_UNAVAILABLE", statusCode: 503 });
});

test("import scanner shares the transport: verdicts, size codes and abort behave as before", async () => {
  const clean = await fakeClamd("clean");
  const infected = await fakeClamd("infected");
  const input = (data: Buffer, size = data.length, signal = new AbortController().signal) => ({ size, openPrivateRead: open(data), signal } as never);
  try {
    assert.equal(await new ClamAvDatasetImportMalwareScanner(configuration(clean.port)).scan(input(bytes(64))), "APPROVED");
    assert.equal(await new ClamAvDatasetImportMalwareScanner(configuration(infected.port)).scan(input(bytes(64))), "QUARANTINED");
    await assert.rejects(new ClamAvDatasetImportMalwareScanner(configuration(clean.port)).scan(input(bytes(64), 10)), { code: "IMPORT_SIZE_MISMATCH" });
    await assert.rejects(new ClamAvDatasetImportMalwareScanner(configuration(clean.port, { maximumBytes: 8 })).scan(input(bytes(64))), { code: "IMPORT_SIZE_INVALID" });
    await assert.rejects(new ClamAvDatasetImportMalwareScanner(configuration(1)).scan(input(bytes(64))), { code: "IMPORT_MALWARE_SCANNER_UNAVAILABLE", statusCode: 503 });
  } finally { await clean.close(); await infected.close(); }
});

test("factories: unconfigured without an endpoint, ClamAV with one (assets and imports use the same variables)", () => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.includes("CLAMAV")) delete process.env[key];
  try {
    assert.ok(malwareScannerFromEnvironment(new FakeObjectStorage(), { maximumBytes: 10 }) instanceof UnconfiguredMalwareScanner);
    assert.ok(datasetImportMalwareScannerFromEnvironment() instanceof UnconfiguredDatasetImportMalwareScanner);
    process.env.CORECROW_CLAMAV_HOST = "corecrow-clamav";
    process.env.CORECROW_CLAMAV_PORT = "3310";
    assert.ok(malwareScannerFromEnvironment(new FakeObjectStorage(), { maximumBytes: 10 }) instanceof ClamAvMalwareScanner);
    assert.ok(datasetImportMalwareScannerFromEnvironment() instanceof ClamAvDatasetImportMalwareScanner);
  } finally {
    for (const key of Object.keys(process.env)) if (key.includes("CLAMAV")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
