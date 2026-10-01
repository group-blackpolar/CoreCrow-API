import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import {
  allows,
  canManageRole,
  effectivePermissions,
} from "../src/modules/authorization/policy.js";
import { healthService } from "../src/modules/health/service.js";
import { healthPage } from "../src/modules/health/page.js";
import { RequestTelemetry } from "../src/modules/telemetry/service.js";
import { validateNorthPanelDocument } from "../src/modules/north/content-schema.js";
import { DomainError } from "../src/shared/errors.js";
import { validateAssetDeclaration, validateInspectedAsset } from "../src/modules/north/asset-policy.js";
import { FakeObjectStorage } from "../src/modules/north/object-storage.js";
import { UnconfiguredMalwareScanner } from "../src/modules/north/malware-scanner.js";
import { resolveDatasetAcl } from "../src/modules/north/data/acl-policy.js";
import { validateDatasetImportDeclaration, validateUploadedDatasetImport } from "../src/modules/north/data/import-policy.js";
import { XLSX_MIME } from "../src/modules/north/data/import-config.js";
import {
  ClamAvDatasetImportMalwareScanner,
  UnconfiguredDatasetImportMalwareScanner,
} from "../src/modules/north/data/import-malware-scanner.js";
import {
  SecureXlsxArchiveValidator,
  UnconfiguredDatasetImportArchiveValidator,
} from "../src/modules/north/data/import-archive-validator.js";
import {
  createDatasetImportWorkerRuntime,
  datasetImportWorkerRuntimeConfiguration,
  runDatasetImportWorkerLoop,
} from "../src/modules/north/data/import-worker-runtime.js";

async function xlsxArchive(extra: Record<string, string> = {}) {
  const zip = new ZipFile();
  const parts: Record<string, string> = {
    "[Content_Types].xml": "<Types><Override ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>",
    "_rels/.rels": "<Relationships><Relationship Type=\"officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
    "xl/workbook.xml": "<workbook><sheets><sheet name=\"Data\"/></sheets></workbook>",
    "xl/_rels/workbook.xml.rels": "<Relationships><Relationship Type=\"worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
    ...extra,
  };
  for (const [name, value] of Object.entries(parts)) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("XLSX declarations and uploaded bytes remain behind the security gate", () => {
  const checksum = "a".repeat(64);
  const declared = validateDatasetImportDeclaration({
    filename: " Master House.XLSX ", mime: XLSX_MIME, size: 4, checksum: checksum.toUpperCase(),
  }, { maximumBytes: 1024, uploadUrlTtlSeconds: 60 });
  assert.equal(declared.filename, "Master House.XLSX");
  assert.equal(declared.checksum, checksum);
  assert.doesNotThrow(() => validateUploadedDatasetImport({
    declaredMime: XLSX_MIME, declaredSize: 4n, declaredChecksum: checksum,
  }, { size: 4, mime: XLSX_MIME, checksum, prefix: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) }));
  assert.throws(() => validateUploadedDatasetImport({
    declaredMime: XLSX_MIME, declaredSize: 4n, declaredChecksum: checksum,
  }, { size: 4, mime: XLSX_MIME, checksum, prefix: Uint8Array.from([0x4d, 0x5a, 0, 0]) }),
  (error) => error instanceof DomainError && error.code === "IMPORT_MAGIC_INVALID");
  assert.throws(() => validateDatasetImportDeclaration({
    filename: "unsafe.xlsm", mime: XLSX_MIME, size: 4, checksum,
  }, { maximumBytes: 1024, uploadUrlTtlSeconds: 60 }),
  (error) => error instanceof DomainError && error.code === "IMPORT_FILE_TYPE_UNSUPPORTED");
});

test("dataset import scanner and ZIP/OOXML validation fail closed when unconfigured", async () => {
  await assert.rejects(
    new UnconfiguredDatasetImportMalwareScanner().scan({} as never),
    (error) => error instanceof DomainError && error.code === "IMPORT_MALWARE_SCANNER_UNAVAILABLE",
  );
  await assert.rejects(
    new UnconfiguredDatasetImportArchiveValidator().validate({} as never),
    (error) => error instanceof DomainError && error.code === "IMPORT_ARCHIVE_VALIDATOR_UNAVAILABLE",
  );
});

test("dataset import worker validates every external dependency before polling", () => {
  const valid: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://corecrow.invalid/corecrow",
    NORTH_DATA_IMPORT_S3_BUCKET: "private-imports",
    NORTH_DATA_IMPORT_S3_REGION: "us-east-1",
    NORTH_DATA_IMPORT_CLAMAV_HOST: "clamav.internal",
    NORTH_DATA_IMPORT_CLAMAV_PORT: "3310",
  };
  const configuration = datasetImportWorkerRuntimeConfiguration(valid);
  assert.equal(configuration.worker.maximumBytes, 50 * 1024 * 1024);
  assert.ok(configuration.worker.heartbeatMilliseconds < configuration.worker.leaseMilliseconds);
  assert.throws(
    () => createDatasetImportWorkerRuntime(configuration),
    /disabled until every security stage reads one pinned immutable object version/,
  );
  assert.throws(
    () => datasetImportWorkerRuntimeConfiguration({ ...valid, NORTH_DATA_IMPORT_S3_BUCKET: "" }),
    /NORTH_DATA_IMPORT_S3_BUCKET is required/,
  );
  assert.throws(
    () => datasetImportWorkerRuntimeConfiguration({
      ...valid,
      NORTH_DATA_IMPORT_CLAMAV_SOCKET: "/run/clamav/clamd.sock",
    }),
    /must use either a socket or host and port/,
  );
  assert.throws(
    () => datasetImportWorkerRuntimeConfiguration({
      ...valid,
      NORTH_DATA_IMPORT_WORKER_LEASE_MS: "5000",
      NORTH_DATA_IMPORT_WORKER_HEARTBEAT_MS: "5000",
    }),
    /must be less than the lease duration/,
  );
  assert.throws(
    () => datasetImportWorkerRuntimeConfiguration({
      ...valid,
      NORTH_DATA_IMPORT_MAX_BYTES: String(50 * 1024 * 1024 + 1),
    }),
    /NORTH_DATA_IMPORT_MAX_BYTES must be an integer between 1 and 52428800/,
  );
});

test("dataset import worker loop stops polling cleanly", async () => {
  const shutdown = new AbortController();
  let runs = 0;
  await runDatasetImportWorkerLoop({
    async runOnce() {
      runs += 1;
      shutdown.abort();
      return "IDLE";
    },
  }, { pollMilliseconds: 100 }, shutdown.signal);
  assert.equal(runs, 1);

  const alreadyStopped = new AbortController();
  alreadyStopped.abort();
  await runDatasetImportWorkerLoop({
    async runOnce() {
      assert.fail("A stopped loop must not consume jobs");
    },
  }, { pollMilliseconds: 100 }, alreadyStopped.signal);
});

test("ClamAV INSTREAM scanner frames private bytes and maps clean and infected results", async (t) => {
  const expected = Buffer.from("private workbook bytes");
  let requests = 0;
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    let commandRead = false;
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!commandRead) {
        const end = pending.indexOf(0);
        if (end < 0) return;
        assert.equal(pending.subarray(0, end).toString("utf8"), "zINSTREAM");
        pending = pending.subarray(end + 1);
        commandRead = true;
      }
      while (pending.byteLength >= 4) {
        const length = pending.readUInt32BE(0);
        if (length === 0) {
          requests += 1;
          if (requests === 5) return;
          const replies = [
            "stream: OK\0",
            "stream: Eicar-Test-Signature FOUND\0",
            "stream: OK",
            "stream: NOT OK\0",
          ];
          socket.end(Buffer.from(replies[requests - 1]!));
          pending = pending.subarray(4);
          return;
        }
        if (pending.byteLength < 4 + length) return;
        received.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  const scanner = new ClamAvDatasetImportMalwareScanner({
    endpoint: { host: "127.0.0.1", port: address.port },
    timeoutMilliseconds: 2_000,
    maximumBytes: 1_024,
    chunkBytes: 5,
  });
  const scanInput = () => ({
    filename: "Master House.xlsx",
    mime: XLSX_MIME,
    size: expected.byteLength,
    checksum: "a".repeat(64),
    openPrivateRead: async () => Readable.from([expected]),
    signal: new AbortController().signal,
  });
  assert.equal(await scanner.scan(scanInput()), "APPROVED");
  assert.equal(await scanner.scan(scanInput()), "QUARANTINED");
  await assert.rejects(
    scanner.scan(scanInput()),
    (error) => error instanceof DomainError && error.code === "IMPORT_MALWARE_SCANNER_UNAVAILABLE",
  );
  await assert.rejects(
    scanner.scan(scanInput()),
    (error) => error instanceof DomainError && error.code === "IMPORT_MALWARE_SCANNER_UNAVAILABLE",
  );
  const timeoutScanner = new ClamAvDatasetImportMalwareScanner({
    endpoint: { host: "127.0.0.1", port: address.port },
    timeoutMilliseconds: 30,
    maximumBytes: 1_024,
    chunkBytes: 5,
  });
  await assert.rejects(
    timeoutScanner.scan(scanInput()),
    (error) => error instanceof DomainError && error.code === "IMPORT_MALWARE_SCANNER_UNAVAILABLE",
  );
  assert.deepEqual(Buffer.concat(received), Buffer.concat([expected, expected, expected, expected, expected]));
});

test("secure XLSX validation accepts passive OOXML and rejects active or unsafe XML content", async () => {
  const validator = new SecureXlsxArchiveValidator();
  const valid = await xlsxArchive();
  const input = (bytes: Buffer) => ({
    filename: "Master House.xlsx",
    size: bytes.byteLength,
    checksum: "a".repeat(64),
    openPrivateRead: async () => Readable.from([bytes]),
    signal: new AbortController().signal,
  });
  assert.equal(await validator.validate(input(valid)), "APPROVED");

  const active = await xlsxArchive({ "xl/vbaProject.bin": "macro" });
  await assert.rejects(
    validator.validate(input(active)),
    (error) => error instanceof DomainError && error.code === "IMPORT_OOXML_ACTIVE_CONTENT",
  );

  const entity = await xlsxArchive({
    "xl/worksheets/sheet1.xml": "<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><worksheet/>",
  });
  await assert.rejects(
    validator.validate(input(entity)),
    (error) => error instanceof DomainError && error.code === "IMPORT_OOXML_ACTIVE_CONTENT",
  );

  const externalRelationship = await xlsxArchive({
    "xl/worksheets/_rels/sheet1.xml.rels": "<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.invalid/data\"/></Relationships>",
  });
  await assert.rejects(
    validator.validate(input(externalRelationship)),
    (error) => error instanceof DomainError && error.code === "IMPORT_OOXML_ACTIVE_CONTENT",
  );

  for (const part of ["xl/activeX/activeX1.bin", "xl/connections.xml", "xl/queryTables/queryTable1.xml"]) {
    const unsafe = await xlsxArchive({ [part]: "unsafe" });
    await assert.rejects(
      validator.validate(input(unsafe)),
      (error) => error instanceof DomainError && error.code === "IMPORT_OOXML_ACTIVE_CONTENT",
    );
  }
});

test("dataset ACL is default-deny and any matching explicit deny wins", () => {
  assert.equal(resolveDatasetAcl([]), false);
  assert.equal(resolveDatasetAcl([{ effect: "ALLOW", matches: false }]), false);
  assert.equal(resolveDatasetAcl([{ effect: "ALLOW", matches: true }]), true);
  assert.equal(resolveDatasetAcl([
    { effect: "ALLOW", matches: true },
    { effect: "DENY", matches: false },
  ]), true);
  assert.equal(resolveDatasetAcl([
    { effect: "ALLOW", matches: true },
    { effect: "DENY", matches: true },
  ]), false);
});

test("permissions deny unknown roles and unknown actions", () => {
  for (const role of [undefined, "", "SUPERADMIN", "__proto__", "toString"])
    assert.equal(allows(role, "members.manage"), false);
  assert.equal(allows("OWNER", "arbitrary:root"), false);
  assert.equal(allows("VIEWER", "members.manage"), false);
  assert.equal(allows("MEMBER", "audit.read"), false);
  assert.equal(allows("OWNER", "members.manage"), true);
});
test("tenant admins cannot promote themselves or change owners", () => {
  assert.equal(canManageRole("ADMIN", "ADMIN", "OWNER"), false);
  assert.equal(canManageRole("ADMIN", "OWNER"), false);
  assert.equal(canManageRole("ADMIN", "MEMBER", "ADMIN"), false);
  assert.equal(canManageRole("ADMIN", "MEMBER", "VIEWER"), true);
  assert.equal(canManageRole("ADMIN", "MEMBER", "BILLING_ADMIN"), true);
  assert.equal(canManageRole("OWNER", "MEMBER", "OWNER"), true);
});

const grid = {
  desktop: { x: 0, y: 0, w: 12, h: 2 },
  tablet: { x: 0, y: 0, w: 12, h: 2 },
  mobile: { x: 0, y: 0, w: 12, h: 2 },
};
const text = { es: "Contenido", en: "Content" };
const componentProps: Record<string, Record<string, unknown>> = {
  heading: { text, level: 1, align: "left" },
  rich_text: { documents: { es: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Seguro", marks: ["bold"] }] }] } } },
  image: { assetId: "asset-image", alt: text, fit: "cover" },
  video: { assetId: "asset-video", title: text, controls: true },
  link: { label: text, href: "https://blackpolar.org", variant: "primary" },
  file: { assetId: "asset-file", label: text },
  table: { columns: [{ key: "value", label: text }], rows: [{ value: 1 }] },
  card: { title: text, body: text, variant: "muted" },
  list: { items: [{ id: "item-1", text }] },
  metric: { label: text, format: "number" },
  divider: { variant: "solid", spacing: "md" },
  embed: { url: "https://www.youtube.com/embed/demo", title: text, aspectRatio: "16:9" },
};
const fullDocument = {
  schemaVersion: 1 as const,
  defaultLocale: "es",
  fallbackLocales: ["en"],
  sections: [{
    id: "section-1", order: 0, layout: { variant: "grid" as const, gap: "md" as const },
    components: Object.entries(componentProps).map(([type, props], order) => ({
      id: `component-${order}`, type, schemaVersion: 1, props,
      bindings: type === "metric" ? { value: { sourceType: "metric" as const, sourceId: "containers.monthly.total" } } : {},
      layout: grid, order,
    })),
  }],
};

async function expectContentError(value: unknown, code: string) {
  await assert.rejects(
    validateNorthPanelDocument(value, {
      organizationId: "org-a",
      actorId: "user-a",
      validateAssetReference: async (_organizationId, assetId) => !assetId.startsWith("foreign"),
      validateBindingReference: async () => true,
    }),
    (error) => error instanceof DomainError && error.statusCode === 422 && error.code === code,
  );
}

test("TASK 8 component registry validates a complete safe catalog document", async () => {
  const result = await validateNorthPanelDocument(fullDocument, {
    organizationId: "org-a",
    actorId: "user-a",
    validateAssetReference: async () => true,
    validateBindingReference: async () => true,
  });
  assert.equal(result.sections[0]!.components.length, 12);
});

test("TASK 8 content validation fails closed for schemas, executable text, grid, embed, binding and assets", async () => {
  const unknown = structuredClone(fullDocument); unknown.sections[0]!.components[0]!.type = "form";
  await expectContentError(unknown, "COMPONENT_SCHEMA_UNKNOWN");
  const version = structuredClone(fullDocument); version.sections[0]!.components[0]!.schemaVersion = 2;
  await expectContentError(version, "COMPONENT_SCHEMA_UNKNOWN");
  const rich = structuredClone(fullDocument); (rich.sections[0]!.components[1]!.props.documents as Record<string, unknown>).es = { type: "doc", content: [{ type: "script", text: "bad" }] };
  await expectContentError(rich, "RICH_TEXT_INVALID");
  const executable = structuredClone(fullDocument); (executable.sections[0]!.components[0]!.props.text as Record<string, string>).es = "<script>alert(1)</script>";
  await expectContentError(executable, "CONTENT_EXECUTABLE_NOT_ALLOWED");
  const layout = structuredClone(fullDocument); layout.sections[0]!.components[0]!.layout.desktop = { x: 10, y: 0, w: 4, h: 1 };
  await expectContentError(layout, "PANEL_DOCUMENT_INVALID");
  const embed = structuredClone(fullDocument); embed.sections[0]!.components[11]!.props.url = "https://unknown-site.example/embed/demo";
  await expectContentError(embed, "EMBED_DOMAIN_NOT_ALLOWED");
  const binding = structuredClone(fullDocument); binding.sections[0]!.components[9]!.bindings = { value: { sourceType: "metric", sourceId: "safe", sql: "select 1" } } as never;
  await expectContentError(binding, "PANEL_DOCUMENT_INVALID");
  const asset = structuredClone(fullDocument); asset.sections[0]!.components[2]!.props.assetId = "foreign-asset";
  await expectContentError(asset, "CROSS_TENANT_RESOURCE");
});
test("TASK 8E asset policy validates allowlist, limits, checksum, MIME and magic bytes", () => {
  const config = {
    uploadUrlTtlSeconds: 120,
    readUrlTtlSeconds: 60,
    defaultOrganizationStorageLimitBytes: 1024,
    maximumBytes: { image: 10, document: 50, video: 250 },
  };
  assert.throws(
    () => validateAssetDeclaration({ filename: "bad.svg", mime: "image/svg+xml", size: 5, checksum: "a".repeat(64) }, config),
    (error) => error instanceof DomainError && error.code === "ASSET_MIME_NOT_ALLOWED",
  );
  assert.throws(
    () => validateAssetDeclaration({ filename: "large.png", mime: "image/png", size: 11, checksum: "a".repeat(64) }, config),
    (error) => error instanceof DomainError && error.code === "ASSET_SIZE_INVALID",
  );
  assert.throws(
    () => validateInspectedAsset(
      { mime: "image/png", size: 8n, checksum: "a".repeat(64) },
      { mime: "image/png", size: 8, checksum: "a".repeat(64), prefix: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]) },
    ),
    (error) => error instanceof DomainError && error.code === "ASSET_MAGIC_MISMATCH",
  );
  assert.throws(
    () => validateInspectedAsset(
      { mime: "image/png", size: 8n, checksum: "a".repeat(64) },
      { mime: "image/png", size: 8, checksum: "b".repeat(64), prefix: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ),
    (error) => error instanceof DomainError && error.code === "ASSET_CHECKSUM_MISMATCH",
  );
});

test("TASK 8E signed URL expiry is explicit and bounded by configuration", async () => {
  const storage = new FakeObjectStorage();
  const before = Date.now();
  const signed = await storage.signedPut({ key: "opaque", mime: "image/png", size: 8, checksum: "a".repeat(64), ttlSeconds: 90 });
  assert.ok(signed.expiresAt.getTime() >= before + 89_000);
  assert.ok(signed.expiresAt.getTime() <= Date.now() + 91_000);
});
test("shared object storage exposes uploaded bytes through a private stream", async () => {
  const storage = new FakeObjectStorage();
  const expected = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  storage.put("tenant/import.xlsx", {
    bytes: expected,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    checksum: "a".repeat(64),
  });

  const chunks: Buffer[] = [];
  for await (const chunk of await storage.openPrivateRead("tenant/import.xlsx"))
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

  assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected));
});
test("TASK 8E unconfigured malware scanning fails closed", async () => {
  await assert.rejects(
    new UnconfiguredMalwareScanner().scan({ storageKey: "opaque", mime: "image/png", size: 8, checksum: "a".repeat(64) }),
    (error) => error instanceof DomainError && error.statusCode === 503 && error.code === "MALWARE_SCANNER_UNAVAILABLE",
  );
});
test("effective permissions are a deterministic default-deny union", () => {
  assert.deepEqual(
    effectivePermissions(
      "BILLING_ADMIN",
      ["organization.update", "unknown.permission"],
      ["audit.read", "organization.update"],
    ),
    [
      "organization.read",
      "organization.update",
      "members.read",
      "groups.read",
      "audit.read",
      "commerce.read",
      "billing.read",
      "billing.manage",
    ],
  );
  assert.deepEqual(effectivePermissions("SUPERADMIN", ["not.registered"]), []);
});
test("health reflects a failed dependency rather than inventing uptime history", async () => {
  const health = healthService(
    async () => [{ name: "Identity", status: "unavailable" }],
    async () => "unavailable",
  );
  const state = await health();
  assert.equal(state.status, "degraded");
  assert.equal(state.apiVersion, "v1");
  assert.equal(state.emailDelivery, "configured");
  assert.equal(state.emailTransport, "unavailable");
  assert.ok(state.uptimeSeconds >= 0);
  const telemetry = new RequestTelemetry();
  const page = healthPage(state, telemetry.summary("24h"));
  assert.match(page, /Process uptime/);
  assert.match(page, /Waiting for real traffic/);
  assert.match(page, /Requests \/ second<\/small><strong>0\.000/);
  assert.doesNotMatch(page, /Esperando tráfico real/);
});

test("telemetry exposes only real sanitized aggregates", () => {
  let now = Date.parse("2026-09-15T12:00:00.000Z");
  const telemetry = new RequestTelemetry(() => now);
  now += 1000;
  telemetry.record(12, 200);
  now += 1000;
  telemetry.record(75, 404);
  now += 1000;
  telemetry.record(150, 503);
  const summary = telemetry.summary("1h");
  assert.equal(summary.requests, 3);
  assert.equal(summary.requestsPerSecond, 1);
  assert.deepEqual(summary.errors, { client: 1, server: 1 });
  assert.equal(summary.latencyMs.average, 79);
  assert.equal(summary.latencyMs.p50, 100);
  assert.equal(summary.latencyMs.p95, 250);
  assert.equal(summary.series.length, 1);
  assert.deepEqual(Object.keys(summary.series[0]!).sort(), [
    "averageLatencyMs",
    "errors4xx",
    "errors5xx",
    "requests",
    "startedAt",
  ]);
  const page = healthPage(
    {
      status: "operational",
      apiVersion: "v1",
      uptimeSeconds: 3,
      checkedAt: new Date(now).toISOString(),
      modules: [],
      emailDelivery: "configured",
      emailTransport: "available",
      commerceMode: "contract_provisioning",
    },
    summary,
  );
  assert.match(page, /class="traffic-bar/);
  assert.match(page, /class="chart-tooltip"/);
  assert.match(page, /data-latency="79"/);
  assert.doesNotMatch(page, /traffic-area/);
  assert.doesNotMatch(page, /Historial de tráfico/);
});
