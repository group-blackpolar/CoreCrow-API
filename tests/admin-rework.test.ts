import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { inspectionAllowsNorth, inspectionPermissions } from "../src/modules/authorization/inspection.js";
import { validateOrganizationIcon } from "../src/modules/tenancy/icon.js";

test("inspection grants read permissions only", () => {
  assert.ok(inspectionPermissions.length > 0);
  for (const permission of inspectionPermissions) assert.match(permission, /\.read$/);
  assert.equal(inspectionAllowsNorth("north.panel.read"), true);
  assert.equal(inspectionAllowsNorth("north.panel.publish"), false);
  assert.equal(inspectionAllowsNorth("north.permission.manage"), false);
});

const png = (side: number) =>
  sharp({ create: { width: side, height: side, channels: 3, background: "#123456" } }).png().toBuffer();

test("organization icon accepts a small image and rejects oversize or fake data", async () => {
  const ok = `data:image/png;base64,${(await png(64)).toString("base64")}`;
  assert.equal(await validateOrganizationIcon(ok), ok);
  await assert.rejects(validateOrganizationIcon(`data:image/png;base64,${(await png(600)).toString("base64")}`), /512/);
  await assert.rejects(validateOrganizationIcon(`data:image/png;base64,${Buffer.from("not an image at all").toString("base64")}`));
  await assert.rejects(validateOrganizationIcon("https://example.com/a.png"));
});

import { decryptAuid, encryptAuid } from "../src/modules/identity/auid-crypto.js";
import { sensitiveInspectionEvent } from "../src/modules/authorization/inspection.js";

test("AUID ciphertext round-trips, is bound to its owner and detects tampering", () => {
  process.env.AUID_ENCRYPTION_KEY = "11".repeat(32);
  const sealed = encryptAuid("user-1", "AUID-ABCDEFGHJKLMNPQRSTUVWXYZ");
  assert.ok(sealed && sealed.ciphertext.startsWith("v1:") && !sealed.ciphertext.includes("AUID-"));
  assert.equal(decryptAuid("user-1", sealed.ciphertext, sealed.version), "AUID-ABCDEFGHJKLMNPQRSTUVWXYZ");
  assert.throws(() => decryptAuid("user-2", sealed.ciphertext, sealed.version));
  const parts = sealed.ciphertext.split(":");
  parts[2] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptAuid("user-1", parts.join(":"), 1));
  assert.notEqual(encryptAuid("user-1", "x")!.ciphertext, encryptAuid("user-1", "x")!.ciphertext);
  process.env.AUID_ENCRYPTION_KEY = "short";
  assert.throws(() => encryptAuid("user-1", "x"));
  delete process.env.AUID_ENCRYPTION_KEY;
  assert.equal(encryptAuid("user-1", "x"), null);
});

test("only sensitive inspection reads map to audit events", () => {
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/members"), "platform.inspection.users.viewed");
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/members/:userId/permission-grants"), "platform.inspection.permissions.viewed");
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/permissions"), null, "own capability discovery is not logged");
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/groups"), "platform.inspection.permissions.viewed");
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/audit"), "platform.inspection.audit.viewed");
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/navigation"), null);
  assert.equal(sensitiveInspectionEvent("/v1/organizations/:organizationId/panels/:panelId"), null);
});
