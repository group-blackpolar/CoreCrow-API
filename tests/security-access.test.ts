import test from "node:test";
import assert from "node:assert/strict";
import { evaluateIp, matchesCidr, normalizeAddress, parseCidr, parseTrustedProxies } from "../src/modules/security-access/network.js";
import { governingPolicy } from "../src/modules/security-access/enforcement.js";
import { effectivePermissions, permissions } from "../src/modules/authorization/policy.js";

test("addresses: IPv4, IPv6, CIDR and mapped addresses", () => {
  assert.equal(parseCidr("10.0.0.5")?.text, "10.0.0.5/32");
  assert.equal(parseCidr("10.0.0.0/8")?.text, "10.0.0.0/8");
  assert.equal(parseCidr("2001:db8::/32")?.family, "ipv6");
  for (const bad of ["", "10.0.0.0/33", "10.0.0.256", "abc", "1.2.3.4/x", "1.2.3.4/8/8", "::1/129"]) assert.equal(parseCidr(bad), null, bad);
  assert.equal(normalizeAddress("::FFFF:1.2.3.4"), "1.2.3.4");
  assert.ok(matchesCidr("10.1.2.3", "10.0.0.0/8"));
  assert.ok(matchesCidr("::ffff:10.1.2.3", "10.0.0.0/8"));
  assert.ok(!matchesCidr("11.1.2.3", "10.0.0.0/8"));
  assert.ok(matchesCidr("2001:db8::1", "2001:db8::/32"));
  assert.ok(!matchesCidr("2001:db9::1", "2001:db8::/32"));
  assert.ok(!matchesCidr("10.0.0.1", "2001:db8::/32"));
});

test("precedence: deny beats allow; empty list allows; allow list is exclusive", () => {
  assert.deepEqual(evaluateIp("1.1.1.1", []), { allowed: true });
  assert.equal(evaluateIp("1.1.1.1", [{ kind: "DENY", cidr: "2.2.2.2/32" }]).allowed, true);
  assert.deepEqual(evaluateIp("1.1.1.1", [{ kind: "ALLOW", cidr: "2.2.2.0/24" }]), { allowed: false, reason: "not_allowed" });
  assert.equal(evaluateIp("2.2.2.9", [{ kind: "ALLOW", cidr: "2.2.2.0/24" }]).allowed, true);
  const both = [{ kind: "ALLOW", cidr: "2.2.2.0/24" }, { kind: "DENY", cidr: "2.2.2.9/32" }] as const;
  assert.deepEqual(evaluateIp("2.2.2.9", both), { allowed: false, reason: "denied" });
  assert.equal(evaluateIp("2.2.2.8", both).allowed, true);
  assert.equal(evaluateIp(null, [{ kind: "ALLOW", cidr: "2.2.2.0/24" }]).allowed, false);
});

test("trusted proxies: only valid entries are trusted", () => {
  assert.equal(parseTrustedProxies(undefined), false);
  assert.equal(parseTrustedProxies("garbage"), false);
  assert.equal(parseTrustedProxies("loopback"), "loopback");
  assert.equal(parseTrustedProxies("10.0.0.1"), "10.0.0.1");
  assert.deepEqual(parseTrustedProxies("10.0.0.0/8, bad ,127.0.0.1"), ["10.0.0.0/8", "127.0.0.1"]);
});

test("governing policy: owner org wins; strictest limits among enforcing orgs; no policy = untracked", () => {
  const row = (organizationId: string, extra: Partial<Parameters<typeof governingPolicy>[0][number]> = {}) => ({ organizationId, enforcement: true, maxDevices: null, maxSessions: null, overflowPolicy: "BLOCK_NEW" as const, ...extra });
  assert.equal(governingPolicy([], null), null);
  const a = row("a", { maxSessions: 5, overflowPolicy: "REPLACE_OLDEST" });
  const b = row("b", { maxSessions: 2, maxDevices: 3, overflowPolicy: "REQUIRE_USER_CHOICE" });
  const merged = governingPolicy([a, b], null)!;
  assert.deepEqual([merged.maxSessions, merged.maxDevices, merged.overflow, merged.organizationId], [2, 3, "REQUIRE_USER_CHOICE", "a"]);
  const managed = governingPolicy([a, b], "b")!;
  assert.deepEqual([managed.maxSessions, managed.overflow, managed.organizationId], [2, "REQUIRE_USER_CHOICE", "b"]);
  const off = governingPolicy([row("a", { enforcement: false, maxSessions: 1 })], null)!;
  assert.deepEqual([off.enforcement, off.maxSessions], [false, null]);
});

test("security permissions: OWNER only by default, never from a group", () => {
  const security = permissions.filter((permission) => permission.startsWith("security."));
  assert.equal(security.length, 13);
  assert.deepEqual(effectivePermissions("OWNER").filter((p) => p.startsWith("security.")), security);
  for (const role of ["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]) assert.equal(effectivePermissions(role).some((p) => p.startsWith("security.")), false, role);
  assert.equal(effectivePermissions("MEMBER", ["security.ips.manage"]).includes("security.ips.manage" as never), false);
  assert.equal(effectivePermissions("MEMBER", [], ["security.ips.manage"]).includes("security.ips.manage" as never), true);
});
