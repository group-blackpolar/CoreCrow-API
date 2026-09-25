import test from "node:test";
import assert from "node:assert/strict";
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
