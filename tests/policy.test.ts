import test from "node:test";
import assert from "node:assert/strict";
import { allows, canManageRole } from "../src/modules/authorization/policy.js";
import { healthService } from "../src/modules/health/service.js";
import { healthPage } from "../src/modules/health/page.js";
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
  const health = healthService(async () => [
    { name: "Identity", status: "unavailable" },
  ]);
  const state = await health();
  assert.equal(state.status, "degraded");
  assert.equal(state.apiVersion, "v1");
  assert.ok(state.uptimeSeconds >= 0);
  const page = healthPage(state);
  assert.match(page, /Process uptime/);
  assert.match(page, /No telemetry data/);
  assert.match(page, /Requests \/ second<\/small><strong class="unavailable-value">—/);
  assert.doesNotMatch(page, /requestsPerSecond|averageLatencyMs/);
});
