import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

// Needs an isolated, migrated PostgreSQL database: TEST_DATABASE_URL=postgresql://.../xxx_test pnpm exec tsx --test tests/media-assets.integration.test.ts
test("Media assets: user avatars and organization icons", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5529?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let value = "";
      stream.on("data", (data) => { value += data; });
      stream.on("end", () => { messages.push(value); callback(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(5529, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { NorthAssetService, configureNorthAssetService } = await import("../src/modules/north/asset-service.js");
  const { UserAvatarService, configureUserAvatarService } = await import("../src/modules/identity/avatar-service.js");
  const { FakeObjectStorage } = await import("../src/infrastructure/object-storage.js");
  const { FakeMalwareScanner, UnconfiguredMalwareScanner } = await import("../src/modules/north/malware-scanner.js");
  const { assetConfiguration } = await import("../src/modules/north/asset-config.js");

  const storage = new FakeObjectStorage();
  const scanner = new FakeMalwareScanner();
  const config = assetConfiguration();
  configureNorthAssetService(new NorthAssetService({ storage, scanner, config }));
  configureUserAvatarService(new UserAvatarService({ storage, scanner, config }));
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let address = 1;
  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.40.${address++ % 250 + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const expect = (response: Res, status: number) => { assert.equal(response.statusCode, status, `${response.statusCode}: ${response.body}`); return response.json(); };
  const cookieOf = (response: Res) => response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let signupAddress = 10;
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    expect(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: `127.0.41.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password, name: label } }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    assert.ok(code);
    expect(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: `127.0.42.${signupAddress++}`, headers: { origin: "http://localhost:3000" }, payload: { email, password } });
    expect(login, 200);
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id: row.id, cookie: cookieOf(login) };
  }

  const png = (seed: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 2, 3, 4]);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  const owner = await account("owner");
  const viewer = await account("viewer");
  const outsider = await account("outsider");
  const orgA = expect(await call("POST", "/v1/organizations", owner.cookie, { name: `Media A ${prefix}` }), 201).id as string;
  const orgB = expect(await call("POST", "/v1/organizations", outsider.cookie, { name: `Media B ${prefix}` }), 201).id as string;
  await prisma.membership.create({ data: { organizationId: orgA, userId: viewer.id, role: "VIEWER" } });

  async function uploadAvatar(cookie: string, bytes: Uint8Array, mime = "image/png") {
    const requested = expect(await call("POST", "/v1/me/avatar/uploads", cookie, { mime, size: bytes.length, checksum: sha(bytes) }), 201);
    const row = await prisma.userAvatar.findUniqueOrThrow({ where: { id: requested.avatar.id } });
    storage.put(row.storageKey, { bytes, mime, checksum: sha(bytes) });
    return { id: requested.avatar.id as string, key: row.storageKey };
  }
  async function readyIconAsset(cookie: string, organizationId: string, bytes: Uint8Array, mime = "image/png") {
    const requested = expect(await call("POST", `/v1/organizations/${organizationId}/assets/uploads`, cookie, { filename: "icon.png", mime, size: bytes.length, checksum: sha(bytes) }), 201);
    const row = await prisma.northAsset.findUniqueOrThrow({ where: { id: requested.asset.id } });
    storage.put(row.storageKey, { bytes, mime, checksum: sha(bytes) });
    expect(await call("POST", `/v1/organizations/${organizationId}/assets/${row.id}/confirm`, cookie), 200);
    return row.id;
  }

  await t.test("avatar: upload, confirm, read, replace and delete keep one live avatar and clean the old object", async () => {
    expect(await call("GET", "/v1/me/avatar", owner.cookie), 200);
    assert.equal(expect(await call("GET", "/v1/me/avatar", owner.cookie), 200).avatar, null);
    const first = await uploadAvatar(owner.cookie, png(1));
    expect(await call("POST", `/v1/me/avatar/${first.id}/confirm`, owner.cookie), 200);
    const read = expect(await call("GET", "/v1/me/avatar", owner.cookie), 200);
    assert.equal(read.avatar.id, first.id);
    assert.equal(read.download.method, "GET");
    assert.equal(JSON.stringify(read).includes("user-avatars/"), false, "storage keys are never exposed");

    const second = await uploadAvatar(owner.cookie, png(2));
    expect(await call("POST", `/v1/me/avatar/${second.id}/confirm`, owner.cookie), 200);
    assert.equal(expect(await call("GET", "/v1/me/avatar", owner.cookie), 200).avatar.id, second.id);
    assert.equal(await prisma.userAvatar.count({ where: { userId: owner.id, status: "READY", deletedAt: null } }), 1);
    assert.equal(storage.objects.has(first.key), false, "replaced avatar object is removed");

    expect(await call("DELETE", "/v1/me/avatar", owner.cookie), 200);
    assert.equal(expect(await call("GET", "/v1/me/avatar", owner.cookie), 200).avatar, null);
    assert.equal(storage.objects.has(second.key), false);
  });

  await t.test("avatar: nobody can touch another user's avatar and anonymous callers are refused", async () => {
    const mine = await uploadAvatar(owner.cookie, png(3));
    assert.equal((await call("POST", `/v1/me/avatar/${mine.id}/confirm`, outsider.cookie)).statusCode, 404);
    assert.equal((await call("GET", "/v1/me/avatar")).statusCode, 401);
    assert.equal((await call("DELETE", "/v1/me/avatar")).statusCode, 401);
    expect(await call("POST", `/v1/me/avatar/${mine.id}/confirm`, owner.cookie), 200);
    assert.equal(expect(await call("GET", "/v1/me/avatar", outsider.cookie), 200).avatar, null);
    expect(await call("DELETE", "/v1/me/avatar", owner.cookie), 200);
  });

  await t.test("avatar: format, size, spoofed bytes and scanner outcomes are enforced", async () => {
    const bytes = png(4);
    assert.equal((await call("POST", "/v1/me/avatar/uploads", owner.cookie, { mime: "image/gif", size: bytes.length, checksum: sha(bytes) })).statusCode, 422);
    assert.equal((await call("POST", "/v1/me/avatar/uploads", owner.cookie, { mime: "application/pdf", size: bytes.length, checksum: sha(bytes) })).statusCode, 422);
    assert.equal((await call("POST", "/v1/me/avatar/uploads", owner.cookie, { mime: "image/png", size: 3 * 1024 * 1024, checksum: sha(bytes) })).statusCode, 422);

    const spoofed = await uploadAvatar(owner.cookie, Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]), "image/png");
    assert.equal((await call("POST", `/v1/me/avatar/${spoofed.id}/confirm`, owner.cookie)).statusCode, 422);
    assert.equal((await prisma.userAvatar.findUniqueOrThrow({ where: { id: spoofed.id } })).status, "REJECTED");

    scanner.verdict = "QUARANTINED";
    const quarantined = await uploadAvatar(owner.cookie, png(5));
    assert.equal((await call("POST", `/v1/me/avatar/${quarantined.id}/confirm`, owner.cookie)).statusCode, 422);
    scanner.verdict = "APPROVED";
    assert.equal(await prisma.userAvatar.count({ where: { userId: owner.id, status: "READY", deletedAt: null } }), 0);
  });

  await t.test("avatar: storage or scanner failure leaves no READY avatar and the upload can be retried", async () => {
    const missing = expect(await call("POST", "/v1/me/avatar/uploads", owner.cookie, { mime: "image/png", size: 12, checksum: sha(png(6)) }), 201);
    assert.equal((await call("POST", `/v1/me/avatar/${missing.avatar.id}/confirm`, owner.cookie)).statusCode, 503);
    assert.equal((await prisma.userAvatar.findUniqueOrThrow({ where: { id: missing.avatar.id } })).status, "PROCESSING");
    const row = await prisma.userAvatar.findUniqueOrThrow({ where: { id: missing.avatar.id } });
    storage.put(row.storageKey, { bytes: png(6), mime: "image/png", checksum: sha(png(6)) });
    configureUserAvatarService(new UserAvatarService({ storage, scanner: new UnconfiguredMalwareScanner(), config }));
    assert.equal((await call("POST", `/v1/me/avatar/${missing.avatar.id}/confirm`, owner.cookie)).statusCode, 503, "unconfigured scanner fails closed");
    configureUserAvatarService(new UserAvatarService({ storage, scanner, config }));
    expect(await call("POST", `/v1/me/avatar/${missing.avatar.id}/confirm`, owner.cookie), 200);
    expect(await call("DELETE", "/v1/me/avatar", owner.cookie), 200);
  });

  await t.test("org icon: an authorized admin links a READY same-tenant asset; members read it, outsiders cannot", async () => {
    const asset = await readyIconAsset(owner.cookie, orgA, png(7));
    const updated = expect(await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: asset }), 200);
    assert.equal(updated.iconAssetId, asset);
    assert.equal(expect(await call("GET", `/v1/organizations/${orgA}/icon`, viewer.cookie), 200).download.method, "GET");
    // A non-member learns nothing: 403 or 404 are both default-deny; what matters is that no URL is issued.
    for (const denied of [await call("GET", `/v1/organizations/${orgA}/icon`, outsider.cookie), await call("GET", `/v1/organizations/${orgB}/icon`, owner.cookie)]) {
      assert.ok([403, 404].includes(denied.statusCode), String(denied.statusCode));
      assert.equal(denied.body.includes("download"), false);
    }
    assert.equal((await call("GET", `/v1/organizations/${orgB}/icon`, outsider.cookie)).statusCode, 404, "no icon set");
    assert.equal((await call("PATCH", `/v1/organizations/${orgA}`, viewer.cookie, { iconAssetId: asset })).statusCode, 403);
    assert.ok([403, 404].includes((await call("PATCH", `/v1/organizations/${orgA}`, outsider.cookie, { iconAssetId: asset })).statusCode));
  });

  await t.test("org icon: foreign, unknown, unready and wrong-type assets cannot be referenced", async () => {
    const foreign = await readyIconAsset(outsider.cookie, orgB, png(8));
    assert.equal((await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: foreign })).statusCode, 422, "other tenant's asset");
    assert.equal((await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: randomUUID().replace(/-/g, "") })).statusCode, 422, "unknown asset");
    const pending = expect(await call("POST", `/v1/organizations/${orgA}/assets/uploads`, owner.cookie, { filename: "p.png", mime: "image/png", size: 12, checksum: sha(png(9)) }), 201);
    assert.equal((await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: pending.asset.id })).statusCode, 422, "not READY");
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6]);
    const gifAsset = await readyIconAsset(owner.cookie, orgA, gif, "image/gif");
    assert.equal((await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: gifAsset })).statusCode, 422, "gif is not an icon");
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: orgA } })).iconAssetId !== foreign, true);
    await assert.rejects(prisma.organization.update({ where: { id: orgA }, data: { iconAssetId: foreign } }), "the composite foreign key rejects cross-tenant references even bypassing the service");
  });

  await t.test("org icon: the referenced asset cannot be deleted; clearing releases it; legacy iconData stays until replaced", async () => {
    const current = (await prisma.organization.findUniqueOrThrow({ where: { id: orgA } })).iconAssetId!;
    await prisma.organization.update({ where: { id: orgA }, data: { iconData: "data:image/png;base64,legacy" } });
    assert.equal((await call("DELETE", `/v1/organizations/${orgA}/assets/${current}`, owner.cookie)).statusCode, 409);
    const cleared = expect(await call("PATCH", `/v1/organizations/${orgA}`, owner.cookie, { iconAssetId: null }), 200);
    assert.equal(cleared.iconAssetId, null);
    assert.equal(cleared.iconData, "data:image/png;base64,legacy", "legacy data is never erased by an asset change");
    expect(await call("DELETE", `/v1/organizations/${orgA}/assets/${current}`, owner.cookie), 200);
    assert.equal((await call("GET", `/v1/organizations/${orgA}/icon`, owner.cookie)).statusCode, 404);
  });

  await t.test("version pinning: READY records the scanned VersionId, reads stay pinned after an overwrite, and the database requires it", async () => {
    const asset = await readyIconAsset(owner.cookie, orgA, png(20));
    const row = await prisma.northAsset.findUniqueOrThrow({ where: { id: asset } });
    assert.ok(row.storageVersionId && row.storageVersionId !== "null", "READY stores the scanned version");
    // A replayed signed PUT writes a new, unscanned version of the same key.
    storage.put(row.storageKey, { bytes: png(21), mime: "image/png", checksum: sha(png(21)) });
    const read = expect(await call("GET", `/v1/organizations/${orgA}/assets/${asset}/read`, owner.cookie), 200);
    assert.ok(read.download.url.includes(encodeURIComponent(row.storageVersionId)), "the signed read targets the scanned version");
    await assert.rejects(prisma.northAsset.update({ where: { id: asset }, data: { storageVersionId: null } }), "a READY asset cannot lose its version");
    await prisma.northAsset.update({ where: { id: asset }, data: { deletedAt: new Date() } });
    const mine = await uploadAvatar(owner.cookie, png(22));
    expect(await call("POST", `/v1/me/avatar/${mine.id}/confirm`, owner.cookie), 200);
    const avatar = await prisma.userAvatar.findUniqueOrThrow({ where: { id: mine.id } });
    assert.ok(avatar.storageVersionId);
    storage.put(mine.key, { bytes: png(23), mime: "image/png", checksum: sha(png(23)) });
    assert.ok(expect(await call("GET", "/v1/me/avatar", owner.cookie), 200).download.url.includes(encodeURIComponent(avatar.storageVersionId!)));
    await assert.rejects(prisma.userAvatar.update({ where: { id: mine.id }, data: { storageVersionId: null } }));
    expect(await call("DELETE", "/v1/me/avatar", owner.cookie), 200);
    assert.equal(storage.objects.has(mine.key), false, "delete purges the object");
  });

  await t.test("unversioned storage fails closed: confirmation is a retryable 503 and nothing becomes READY", async () => {
    const unversioned = new FakeObjectStorage(false);
    configureNorthAssetService(new NorthAssetService({ storage: unversioned, scanner, config }));
    configureUserAvatarService(new UserAvatarService({ storage: unversioned, scanner, config }));
    try {
      const bytes = png(30);
      const requested = expect(await call("POST", "/v1/me/avatar/uploads", owner.cookie, { mime: "image/png", size: bytes.length, checksum: sha(bytes) }), 201);
      const row = await prisma.userAvatar.findUniqueOrThrow({ where: { id: requested.avatar.id } });
      unversioned.put(row.storageKey, { bytes, mime: "image/png", checksum: sha(bytes) });
      const refused = await call("POST", `/v1/me/avatar/${row.id}/confirm`, owner.cookie);
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.json().error.code, "ASSET_STORAGE_IMMUTABILITY_UNAVAILABLE");
      assert.equal((await prisma.userAvatar.findUniqueOrThrow({ where: { id: row.id } })).status, "PROCESSING");
      const asset = expect(await call("POST", `/v1/organizations/${orgA}/assets/uploads`, owner.cookie, { filename: "u.png", mime: "image/png", size: bytes.length, checksum: sha(bytes) }), 201);
      const assetRow = await prisma.northAsset.findUniqueOrThrow({ where: { id: asset.asset.id } });
      unversioned.put(assetRow.storageKey, { bytes, mime: "image/png", checksum: sha(bytes) });
      assert.equal((await call("POST", `/v1/organizations/${orgA}/assets/${assetRow.id}/confirm`, owner.cookie)).statusCode, 503);
      assert.notEqual((await prisma.northAsset.findUniqueOrThrow({ where: { id: assetRow.id } })).status, "READY");
    } finally {
      configureNorthAssetService(new NorthAssetService({ storage, scanner, config }));
      configureUserAvatarService(new UserAvatarService({ storage, scanner, config }));
    }
  });
});
