import test from "node:test";
import assert from "node:assert/strict";
import { allows, canManageRole } from "../src/modules/authorization/policy.js";
import { healthService } from "../src/modules/health/service.js";
import { healthPage } from "../src/modules/health/page.js";
import { RequestTelemetry } from "../src/modules/telemetry/service.js";
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
  assert.equal(canManageRole("OWNER", "MEMBER", "OWNER"), true);
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
  assert.match(page, /Tiempo activo del proceso/);
  assert.match(page, /Esperando tráfico real/);
  assert.match(page, /Solicitudes \/ segundo<\/small><strong>0\.000/);
  assert.doesNotMatch(page, /Requiere un endpoint de telemetría/);
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
});
