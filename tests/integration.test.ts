import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { hashPassword, verifyPassword } from "better-auth/crypto";

test(
  "PostgreSQL foundation integration",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const testUrl = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(testUrl.hostname) &&
        testUrl.pathname.endsWith("_test"),
      "Tests require a dedicated local *_test database",
    );
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.BETTER_AUTH_URL = "http://localhost:4000";
    process.env.BETTER_AUTH_SECRET =
      "isolated-tests-only-strong-secret-1234567890";
    process.env.TRUSTED_ORIGINS = "http://localhost:3000";
    process.env.SMTP_URL = "smtp://127.0.0.1:5525?ignoreTLS=true";
    process.env.MAIL_FROM = "identity@blackpolar.test";
    process.env.CONTACT_NOTIFICATION_TO = "contact@blackpolar.test";
    process.env.GOOGLE_CLIENT_ID = "integration-test-client";
    process.env.GOOGLE_CLIENT_SECRET = "integration-test-secret";
    const messages: string[] = [];
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, _session, callback) {
        let value = "";
        stream.on("data", (data) => {
          value += data;
        });
        stream.on("end", () => {
          messages.push(value);
          callback();
        });
      },
    });
    await new Promise<void>((resolve) =>
      smtp.listen(5525, "127.0.0.1", resolve),
    );
    const { buildApp } = await import("../src/app.js");
    const { prisma } = await import("../src/lib/database.js");
    const { auditRepository } =
      await import("../src/modules/audit/repository.js");
    const { NorthAssetService, configureNorthAssetService } =
      await import("../src/modules/north/asset-service.js");
    const { FakeObjectStorage } = await import("../src/modules/north/object-storage.js");
    const { FakeMalwareScanner } = await import("../src/modules/north/malware-scanner.js");
    const { assetConfiguration } = await import("../src/modules/north/asset-config.js");
    const { NorthDatasetImportService, configureNorthDatasetImportService } =
      await import("../src/modules/north/data/import-service.js");
    const { datasetImportConfiguration } = await import("../src/modules/north/data/import-config.js");
    const { NorthDatasetImportWorker } = await import("../src/modules/north/data/import-worker.js");
    const { NorthDatasetImportAnalysisWorker } = await import("../src/modules/north/data/import-analysis-worker.js");
    const { NorthDatasetImportMaterializationWorker } = await import("../src/modules/north/data/import-materialization-worker.js");
    const { UnconfiguredDatasetImportMalwareScanner } = await import("../src/modules/north/data/import-malware-scanner.js");
    const { UnconfiguredDatasetImportArchiveValidator } = await import("../src/modules/north/data/import-archive-validator.js");
    const { UnavailableObjectStorage } = await import("../src/infrastructure/object-storage.js");
    const assetStorage = new FakeObjectStorage();
    const importStorage = new FakeObjectStorage();
    const assetScanner = new FakeMalwareScanner();
    configureNorthAssetService(new NorthAssetService({
      storage: assetStorage,
      scanner: assetScanner,
      config: assetConfiguration(),
    }));
    configureNorthDatasetImportService(new NorthDatasetImportService({
      storage: importStorage,
      configuration: datasetImportConfiguration(),
    }));
    const app = await buildApp({ logger: false });
    await app.ready();
    t.after(async () => {
      await app.close();
      await prisma.$disconnect();
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    });
    const prefix = randomUUID().slice(0, 8);
    const password = "Test-password-only-123!";
    let callAddress = 1;
    const call = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      cookie?: string,
      payload?: unknown,
      extra = {},
    ) =>
      app.inject({
        method,
        url,
        remoteAddress: `127.0.1.${callAddress++}`,
        headers: {
          origin: "http://localhost:3000",
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
    const expect = (
      response: Awaited<ReturnType<typeof call>>,
      status: number,
    ) => {
      assert.equal(
        response.statusCode,
        status,
        `${response.statusCode}: ${response.body}`,
      );
      return response.json();
    };
    const cookieOf = (response: Awaited<ReturnType<typeof call>>) =>
      response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const verificationCodeFromLastMail = () => {
      const rawMail = messages.at(-1)!.replace(/=\r?\n/g, "");
      const code = rawMail.match(/verification code is: (\d{6})/i)?.[1];
      assert.ok(code, "Verification email includes a six-digit code");
      assert.doesNotMatch(rawMail, /\/v1\/auth\/verify-email/i);
      return code;
    };
    const invitationTokenFromLastMail = () => {
      const rawMail = messages
        .at(-1)!
        .replace(/=\r?\n/g, "")
        .replace(/=3D/gi, "=");
      const token = rawMail.match(/[?&]invitation=([a-f0-9]{64})/i)?.[1];
      assert.ok(token, "Invitation email includes the single-use credential");
      return token;
    };
    let signupAddress = 10;
    async function signup(label: string) {
      const email = `${prefix}-${label}@blackpolar.test`;
      const remoteAddress = `127.0.0.${signupAddress++}`;
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/sign-up/email",
        remoteAddress,
        headers: { origin: "http://localhost:3000" },
        payload: {
          email,
          password,
          name: label,
          role: "SUPERADMIN",
        },
      });
      expect(response, 200);
      const record = await prisma.user.findUniqueOrThrow({ where: { email } });
      assert.equal(record.role, "USER");
      const code = verificationCodeFromLastMail();
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email,
          code,
        }),
        200,
      );
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/sign-in/email",
        remoteAddress,
        headers: { origin: "http://localhost:3000" },
        payload: { email, password },
      });
      expect(login, 200);
      return { id: record.id, email, cookie: cookieOf(login) };
    }

    await t.test("CORS and optimistic-concurrency contracts are explicit", async () => {
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/v1/organizations/example/panels/example/draft",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type,if-match",
        },
      });
      assert.equal(preflight.statusCode, 204);
      assert.match(preflight.headers["access-control-allow-methods"] ?? "", /PUT/);
      assert.match(preflight.headers["access-control-allow-headers"] ?? "", /If-Match/i);

      const specification = app.swagger() as { paths: Record<string, Record<string, { parameters?: Array<{ in: string; name: string; required?: boolean }> }>> };
      const header = (path: string, method: string) => specification.paths[path]![method]!.parameters!.find((item) => item.in === "header" && item.name.toLowerCase() === "if-match");
      assert.equal(header("/v1/organizations/{organizationId}/panels/{panelId}/draft", "patch")?.required, false);
      assert.equal(header("/v1/organizations/{organizationId}/panels/{panelId}/publish", "post")?.required, true);
      assert.equal(header("/v1/organizations/{organizationId}/panels/{panelId}/revisions/{revisionId}/restore", "post")?.required, true);
    });
    const owner = await signup("owner");
    const outsider = await signup("outsider");
    const invited = await signup("invited");
    const joiner = await signup("joiner");
    const replacementUser = await signup("replacement");
    let organizationId = "";
    let secondOrg = "";
    let invitationToken = "";
    let subscriptionId = "";
    let keyId = "";
    let keyToken = "";
    await t.test("session authority and public status", async () => {
      expect(await call("GET", "/v1/me"), 401);
      const me = expect(await call("GET", "/v1/me", owner.cookie), 200);
      assert.equal(me.role, "USER");
      assert.equal(me.passwordChangeRequired, false);
      assert.equal(me.termsAcceptedAt, null);
      assert.equal(me.termsVersion, null);
      expect(
        await call("POST", "/v1/me/terms", owner.cookie, {
          version: "outdated",
        }),
        409,
      );
      const accepted = expect(
        await call("POST", "/v1/me/terms", owner.cookie, {
          version: "2026-09-16",
        }),
        200,
      );
      assert.equal(accepted.termsVersion, "2026-09-16");
      assert.ok(accepted.termsAcceptedAt);
      const desktopToken = `north_session_${randomUUID().replaceAll("-", "").repeat(2)}`;
      await prisma.session.create({
        data: {
          userId: owner.id,
          token: desktopToken,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      assert.equal(
        expect(
          await call("GET", "/v1/me", undefined, undefined, {
            authorization: `Bearer ${desktopToken}`,
          }),
          200,
        ).id,
        owner.id,
      );
      const identityConfig = expect(
        await call("GET", "/v1/identity/config"),
        200,
      );
      assert.equal(identityConfig.termsVersion, "2026-09-16");
      assert.equal(identityConfig.googleAuthEnabled, true);
      assert.equal(identityConfig.captchaRequired, false);
      const desktopStart = await call(
        "GET",
        `/v1/desktop-auth/google/start?nonce=${"b".repeat(64)}&challenge=${"c".repeat(64)}&signup=1`,
      );
      assert.equal(desktopStart.statusCode, 302, desktopStart.body);
      assert.match(desktopStart.headers.location ?? "", /^https:\/\/accounts\.google\.com\//);
      expect(await call("GET", "/api/admin/exists"), 404);
      expect(await call("POST", "/api/auth/sign-in/email", undefined, {
        email: owner.email,
        password,
      }), 404);
      const health = expect(await call("GET", "/v1/health"), 200);
      assert.equal(health.status, "operational");
      const telemetry = expect(
        await call("GET", "/v1/status/summary?window=1h"),
        200,
      );
      assert.equal(telemetry.window, "1h");
      assert.ok(telemetry.requests > 0);
      assert.equal(JSON.stringify(telemetry).includes("path"), false);
      assert.equal(JSON.stringify(telemetry).includes("ip"), false);
      expect(await call("GET", "/v1/status/summary?window=30d"), 400);
      const html = await call("GET", "/");
      assert.equal(html.statusCode, 200);
      assert.match(html.body, /CORECROW/);
      assert.doesNotMatch(html.body, /postgresql:\/\//);
      assert.ok(html.headers["content-security-policy"]);
      assert.equal(html.headers["cache-control"], "no-store");
    });
    await t.test("verification codes rotate, expire, limit attempts, and prevent replay", async () => {
      const unverifiedEmail = `${prefix}-unverified@blackpolar.test`;
      const unverifiedId = randomUUID();
      await prisma.user.create({
        data: {
          id: unverifiedId,
          email: unverifiedEmail,
          name: "Unverified",
          accounts: {
            create: {
              accountId: unverifiedId,
              providerId: "credential",
              password: await hashPassword(password),
            },
          },
        },
      });
      const beforeResend = messages.length;
      expect(
        await call("POST", "/v1/identity/verification/send", undefined, {
          email: unverifiedEmail,
        }),
        200,
      );
      assert.equal(messages.length, beforeResend + 1);
      const firstCode = verificationCodeFromLastMail();
      const firstChallenge = await prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { userId: unverifiedId },
      });
      assert.doesNotMatch(firstChallenge.codeHash, /\b\d{6}\b/);
      expect(
        await call("POST", "/v1/identity/verification/send", undefined, {
          email: unverifiedEmail,
        }),
        200,
      );
      const secondCode = verificationCodeFromLastMail();
      const secondChallenge = await prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { userId: unverifiedId },
      });
      assert.notEqual(secondChallenge.codeHash, firstChallenge.codeHash);
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email: unverifiedEmail,
          code: firstCode,
        }),
        400,
      );
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email: unverifiedEmail,
          code: secondCode,
        }),
        200,
      );
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email: unverifiedEmail,
          code: secondCode,
        }),
        400,
      );

      const expiryEmail = `${prefix}-expiry@blackpolar.test`;
      const expiryId = randomUUID();
      await prisma.user.create({
        data: { id: expiryId, email: expiryEmail, name: "Expiry" },
      });
      expect(
        await call("POST", "/v1/identity/verification/send", undefined, {
          email: expiryEmail,
        }),
        200,
      );
      const expiryCode = verificationCodeFromLastMail();
      await prisma.emailVerificationChallenge.update({
        where: { userId: expiryId },
        data: { expiresAt: new Date(0) },
      });
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email: expiryEmail,
          code: expiryCode,
        }),
        400,
      );

      const attemptsEmail = `${prefix}-attempts@blackpolar.test`;
      const attemptsId = randomUUID();
      await prisma.user.create({
        data: { id: attemptsId, email: attemptsEmail, name: "Attempts" },
      });
      expect(
        await call("POST", "/v1/identity/verification/send", undefined, {
          email: attemptsEmail,
        }),
        200,
      );
      const attemptsCode = verificationCodeFromLastMail();
      for (let attempt = 0; attempt < 5; attempt += 1)
        expect(
          await call("POST", "/v1/identity/verification/confirm", undefined, {
            email: attemptsEmail,
            code: attemptsCode === "000000" ? "111111" : "000000",
          }),
          400,
        );
      const limitedChallenge = await prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { userId: attemptsId },
      });
      assert.equal(limitedChallenge.attempts, 5);
      expect(
        await call("POST", "/v1/identity/verification/confirm", undefined, {
          email: attemptsEmail,
          code: attemptsCode,
        }),
        400,
      );
      const attemptChallenge = await prisma.emailVerificationChallenge.findUnique({
        where: { userId: attemptsId },
      });
      assert.equal(attemptChallenge, null);

      const unknown = expect(
        await call("POST", "/v1/identity/verification/send", undefined, {
          email: `${prefix}-unknown@blackpolar.test`,
        }),
        200,
      );
      assert.deepEqual(unknown, { accepted: true });

      assert.ok(await prisma.auditLog.findFirst({
        where: { actorId: unverifiedId, action: "identity.email_verification.confirmed" },
      }));
    });

    await t.test("password recovery remains generic", async () => {

      const resetEmail = `${prefix}-password-reset@blackpolar.test`;
      const resetId = randomUUID();
      await prisma.user.create({
        data: {
          id: resetId,
          email: resetEmail,
          name: "Password Reset",
          emailVerified: true,
          accounts: {
            create: {
              accountId: resetId,
              providerId: "credential",
              password: await hashPassword(password),
            },
          },
        },
      });
      expect(
        await call("POST", "/v1/auth/request-password-reset", undefined, {
          email: resetEmail,
          redirectTo: "http://localhost:3000",
        }),
        200,
      );
      const rawMail = messages
        .at(-1)!
        .replace(/=\r?\n/g, "")
        .replace(/=3D/g, "=");
      const resetUrl = rawMail.match(
        /http:\/\/localhost:4000\/v1\/auth\/reset-password\/[^\s]+/,
      )?.[0];
      assert.ok(resetUrl, "Password email includes a reset URL");
      const callback = await app.inject({
        method: "GET",
        url: new URL(resetUrl).pathname + new URL(resetUrl).search,
      });
      assert.equal(callback.statusCode, 302, callback.body);
      const token = new URL(callback.headers.location!).searchParams.get("token");
      assert.ok(token);
      const newPassword = "Changed-password-only-456!";
      expect(
        await call("POST", "/v1/auth/reset-password", undefined, {
          token,
          newPassword,
        }),
        200,
      );
      const credential = await prisma.account.findFirstOrThrow({
        where: { userId: resetId, providerId: "credential" },
      });
      assert.ok(credential.password);
      assert.equal(
        await verifyPassword({ hash: credential.password, password }),
        false,
      );
      assert.equal(
        await verifyPassword({ hash: credential.password, password: newPassword }),
        true,
      );
    });
    await t.test("strict validation and tenant isolation", async () => {
      expect(
        await call("POST", "/v1/organizations", owner.cookie, {
          name: "Alpha",
          slug: `${prefix}-alpha`,
          role: "OWNER",
        }),
        400,
      );
      organizationId = expect(
        await call("POST", "/v1/organizations", owner.cookie, {
          name: "Alpha",
          slug: `${prefix}-alpha`,
        }),
        201,
      ).id;
      secondOrg = expect(
        await call("POST", "/v1/organizations", outsider.cookie, {
          name: "Beta",
          slug: `${prefix}-beta`,
        }),
        201,
      ).id;
      const list = expect(
        await call("GET", "/v1/organizations", owner.cookie),
        200,
      );
      assert.equal(list.length, 1);
      assert.equal(list[0].status, "ACTIVE");
      const normalized = expect(
        await call("POST", "/v1/organizations", owner.cookie, {
          name: `${prefix} Café Rocket`,
        }),
        201,
      );
      assert.equal(normalized.slug, `${prefix}-cafe-rocket`);
      expect(
        await call("POST", "/v1/organizations", owner.cookie, {
          name: "Reserved",
          slug: "Admin",
        }),
        409,
      );
      assert.equal(
        expect(
          await call("GET", `/v1/organizations/resolve/${prefix}-alpha`),
          200,
        ).slug,
        `${prefix}-alpha`,
      );
      expect(
        await call(
          "PATCH",
          `/v1/organizations/${organizationId}/status`,
          outsider.cookie,
          { status: "ARCHIVED" },
        ),
        404,
      );
      assert.equal(
        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "ARCHIVED" },
          ),
          200,
        ).status,
        "ARCHIVED",
      );
      expect(await call("GET", `/v1/organizations/resolve/${prefix}-alpha`), 404);
      expect(
        await call(
          "GET",
          `/v1/organizations/${organizationId}/members`,
          owner.cookie,
        ),
        409,
      );
      assert.equal(
        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "ACTIVE" },
          ),
          200,
        ).status,
        "ACTIVE",
      );
      for (const suffix of [
        "",
        "/members",
        "/permissions",
        "/audit",
        "/subscriptions",
        "/entitlements",
      ])
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}${suffix}`,
            outsider.cookie,
          ),
          404,
        );
      expect(
        await call(
          "PATCH",
          `/v1/organizations/${organizationId}`,
          outsider.cookie,
          { name: "Taken" },
        ),
        404,
      );
      expect(
        await call(
          "DELETE",
          `/v1/organizations/${organizationId}/members/${owner.id}`,
          owner.cookie,
        ),
        409,
      );
      expect(
        await call(
          "PATCH",
          `/v1/organizations/${organizationId}/members/${owner.id}`,
          owner.cookie,
          { role: "MEMBER" },
        ),
        409,
      );
      expect(
        await call("PATCH", `/v1/users/${owner.id}`, owner.cookie, {
          role: "SUPERADMIN",
        }),
        403,
      );
    });
    await t.test(
      "invitations bind identity, expire, revoke, and prevent replay",
      async () => {
        const initialGroup = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups`,
            owner.cookie,
            { name: "Invited reviewers" },
          ),
          201,
        );
        const generic = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            {
              kind: "CODE",
              role: "MEMBER",
              groupIds: [initialGroup.id],
              permissions: ["audit.read"],
            },
          ),
          201,
        );
        assert.match(generic.token, /^BP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        assert.equal(generic.email, null);
        assert.equal(generic.delivery, "not_applicable");
        const unverified = await prisma.user.create({
          data: {
            email: `${prefix}-pending-access@blackpolar.test`,
            name: "Pending access",
            emailVerified: false,
          },
        });
        const unverifiedToken = `north_session_${randomUUID().replaceAll("-", "").repeat(2)}`;
        await prisma.session.create({
          data: {
            userId: unverified.id,
            token: unverifiedToken,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const unverifiedAcceptance = await app.inject({
          method: "POST",
          url: "/v1/invitations/accept",
          remoteAddress: "127.0.0.50",
          headers: {
            origin: "http://localhost:3000",
            authorization: `Bearer ${unverifiedToken}`,
          },
          payload: { token: generic.token },
        });
        expect(unverifiedAcceptance, 401);
        assert.equal(
          await prisma.membership.count({ where: { userId: unverified.id } }),
          0,
        );
        expect(
          await call("POST", "/v1/invitations/accept", joiner.cookie, {
            token: generic.token.toLowerCase(),
          }),
          200,
        );
        expect(
          await call("POST", "/v1/invitations/accept", outsider.cookie, {
            token: generic.token,
          }),
          404,
        );
        const joinerMembership = await prisma.membership.findUniqueOrThrow({
          where: {
            organizationId_userId: { organizationId, userId: joiner.id },
          },
        });
        assert.ok(
          await prisma.organizationGroupMember.findUnique({
            where: {
              groupId_membershipId: {
                groupId: initialGroup.id,
                membershipId: joinerMembership.id,
              },
            },
          }),
        );
        assert.ok(
          await prisma.membershipPermissionGrant.findUnique({
            where: {
              membershipId_permission: {
                membershipId: joinerMembership.id,
                permission: "audit.read",
              },
            },
          }),
        );
        const listedInvitations = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(listedInvitations.some((item: object) => "token" in item), false);
        const issuedEmailInvitation = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            { email: invited.email, role: "MEMBER" },
          ),
          201,
        );
        assert.equal("token" in issuedEmailInvitation, false);
        invitationToken = invitationTokenFromLastMail();
        assert.match(messages.at(-1)!, /invited to join Alpha on NORTH/i);
        expect(
          await call("POST", "/v1/invitations/accept", outsider.cookie, {
            token: invitationToken,
          }),
          403,
        );
        expect(
          await call("POST", "/v1/invitations/accept", invited.cookie, {
            token: invitationToken,
          }),
          200,
        );
        expect(
          await call("POST", "/v1/invitations/accept", invited.cookie, {
            token: invitationToken,
          }),
          404,
        );
        const replaceable = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            { email: replacementUser.email },
          ),
          201,
        );
        assert.equal("token" in replaceable, false);
        const replaceableToken = invitationTokenFromLastMail();
        const replacement = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations/${replaceable.id}/replace`,
            owner.cookie,
          ),
          201,
        );
        assert.equal("token" in replacement, false);
        const replacementToken = invitationTokenFromLastMail();
        assert.notEqual(replacementToken, replaceableToken);
        expect(
          await call("POST", "/v1/invitations/accept", replacementUser.cookie, {
            token: replaceableToken,
          }),
          404,
        );
        expect(
          await call("POST", "/v1/invitations/accept", replacementUser.cookie, {
            token: replacementToken,
          }),
          200,
        );
        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            invited.cookie,
            { email: outsider.email, role: "ADMIN" },
          ),
          403,
        );
        const invite = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            { email: outsider.email },
          ),
          201,
        );
        assert.equal("token" in invite, false);
        const revokedToken = invitationTokenFromLastMail();
        expect(
          await call(
            "DELETE",
            `/v1/organizations/${organizationId}/invitations/${invite.id}`,
            owner.cookie,
          ),
          200,
        );
        expect(
          await call("POST", "/v1/invitations/accept", outsider.cookie, {
            token: revokedToken,
          }),
          404,
        );
        const expired = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            { email: outsider.email },
          ),
          201,
        );
        assert.equal("token" in expired, false);
        const expiredToken = invitationTokenFromLastMail();
        await prisma.invitation.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(0) },
        });
        expect(
          await call("POST", "/v1/invitations/accept", outsider.cookie, {
            token: expiredToken,
          }),
          404,
        );
      },
    );
    await t.test(
      "member directory exposes only minimal tenant-visible identity",
      async () => {
        const members = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/members`,
            invited.cookie,
          ),
          200,
        );
        const listedOwner = members.find(
          (member: { userId: string }) => member.userId === owner.id,
        );
        assert.ok(listedOwner);
        assert.deepEqual(Object.keys(listedOwner).sort(), [
          "createdAt",
          "email",
          "id",
          "name",
          "organizationId",
          "role",
          "status",
          "userId",
        ]);
        assert.equal(listedOwner.organizationId, organizationId);
        assert.equal(listedOwner.userId, owner.id);
        assert.notEqual(listedOwner.id, listedOwner.userId);
        assert.equal(listedOwner.email, owner.email);
        assert.equal(listedOwner.name, "owner");
        assert.equal(listedOwner.status, "ACTIVE");
        assert.equal(listedOwner.role, "OWNER");
        assert.match(listedOwner.createdAt, /^\d{4}-\d{2}-\d{2}T/);

        expect(
          await call(
            "GET",
            `/v1/organizations/${secondOrg}/members`,
            owner.cookie,
          ),
          404,
        );
      },
    );
    await t.test(
      "organization groups resolve deterministic grants and reject cross-tenant membership",
      async () => {
        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/members/${invited.id}`,
            owner.cookie,
            { role: "BILLING_ADMIN" },
          ),
          200,
        );
        const base = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/permissions`,
            invited.cookie,
          ),
          200,
        );
        assert.equal(base.role, "BILLING_ADMIN");
        assert.ok(base.permissions.includes("commerce.read"));
        assert.ok(!base.permissions.includes("organization.update"));

        const group = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups`,
            owner.cookie,
            { name: "Editors", description: "Can edit organization details" },
          ),
          201,
        );
        assert.equal(group.description, "Can edit organization details");
        const described = expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/groups/${group.id}`,
            owner.cookie,
            { name: "Organization editors", description: null },
          ),
          200,
        );
        assert.equal(described.name, "Organization editors");
        assert.equal(described.description, null);
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/groups`,
            outsider.cookie,
          ),
          404,
        );
        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups/${group.id}/members`,
            owner.cookie,
            { userId: outsider.id },
          ),
          404,
        );
        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups/${group.id}/members`,
            owner.cookie,
            { userId: invited.id },
          ),
          201,
        );
        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups/${group.id}/permissions`,
            owner.cookie,
            { permission: "organization.update" },
          ),
          201,
        );
        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/groups/${group.id}/permissions`,
            owner.cookie,
            { permission: "not.registered" },
          ),
          400,
        );
        const grouped = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/permissions`,
            invited.cookie,
          ),
          200,
        );
        assert.equal(
          grouped.permissions.filter(
            (permission: string) => permission === "organization.update",
          ).length,
          1,
        );
        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}`,
            invited.cookie,
            { name: "Alpha Updated" },
          ),
          200,
        );
        expect(
          await call(
            "DELETE",
            `/v1/organizations/${organizationId}/groups/${group.id}/permissions/organization.update`,
            owner.cookie,
          ),
          200,
        );
        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}`,
            invited.cookie,
            { name: "Denied" },
          ),
          403,
        );

        expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/members/${invited.id}/permission-grants`,
            owner.cookie,
            { permission: "audit.read" },
          ),
          201,
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/audit`,
            invited.cookie,
          ),
          200,
        );
        expect(
          await call(
            "DELETE",
            `/v1/organizations/${organizationId}/members/${invited.id}/permission-grants/audit.read`,
            owner.cookie,
          ),
          200,
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/audit`,
            invited.cookie,
          ),
          403,
        );

        const secondGroup = expect(
          await call(
            "POST",
            `/v1/organizations/${secondOrg}/groups`,
            outsider.cookie,
            { name: "Other tenant" },
          ),
          201,
        );
        const invitedMembership = await prisma.membership.findUniqueOrThrow({
          where: {
            organizationId_userId: { organizationId, userId: invited.id },
          },
        });
        await assert.rejects(
          prisma.organizationGroupMember.create({
            data: {
              organizationId: secondOrg,
              groupId: secondGroup.id,
              membershipId: invitedMembership.id,
            },
          }),
        );
        const mainInvitation = await prisma.invitation.findFirstOrThrow({
          where: { organizationId },
        });
        await assert.rejects(
          prisma.invitationGroupGrant.create({
            data: {
              organizationId: secondOrg,
              invitationId: mainInvitation.id,
              groupId: secondGroup.id,
            },
          }),
        );
      },
    );
    await t.test(
      "NORTH tenant datasets keep schema snapshots immutable and ACLs tenant-scoped",
      async () => {
        const invitedMembership = await prisma.membership.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId, userId: invited.id } },
        });
        const foreignMembership = await prisma.membership.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId: secondOrg, userId: outsider.id } },
        });

        const dataset = expect(
          await call("POST", `/v1/organizations/${organizationId}/datasets`, owner.cookie, {
            name: { en: "Master House" },
            description: { en: "Tenant import dataset" },
            slug: "master-house",
          }),
          201,
        );
        assert.equal(dataset.organizationId, organizationId);
        assert.equal(dataset.currentSchemaVersionId, null);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, outsider.cookie), 404);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, invited.cookie), 403);

        expect(await call("POST", `/v1/organizations/${organizationId}/north/permission-grants`, owner.cookie, {
          subjectType: "MEMBERSHIP",
          membershipId: invitedMembership.id,
          capability: "north.data.read",
          scope: "ORGANIZATION",
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/acl`, owner.cookie, {
          effect: "ALLOW",
          principalType: "MEMBERSHIP",
          membershipId: invitedMembership.id,
        }), 201);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, invited.cookie), 200);

        const workbook = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
        const workbookChecksum = createHash("sha256").update(workbook).digest("hex");
        const importBody = {
          filename: "master-house.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: workbook.byteLength,
          checksum: workbookChecksum,
        };
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, invited.cookie, importBody, {
          "idempotency-key": `${prefix}-readonly-import`,
        }), 403);
        const prepared = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, importBody, {
          "idempotency-key": `${prefix}-master-import`,
        }), 201);
        assert.equal(prepared.import.status, "AWAITING_UPLOAD");
        assert.equal(prepared.import.scanStatus, "PENDING");
        assert.equal(prepared.import.securityApprovedAt, null);
        assert.equal("storageKey" in prepared.import, false);
        assert.match(prepared.upload.url, /^https:\/\/storage\.invalid\/upload\//);
        const replay = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, importBody, {
          "idempotency-key": `${prefix}-master-import`,
        }), 201);
        assert.equal(replay.import.id, prepared.import.id);
        const conflict = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, {
          ...importBody, filename: "different.xlsx",
        }, { "idempotency-key": `${prefix}-master-import` });
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}`, outsider.cookie), 404);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/confirm`, outsider.cookie), 404);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/cancel`, outsider.cookie), 404);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}`, invited.cookie), 403);
        const unavailableConfirmation = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/confirm`, owner.cookie);
        assert.equal(unavailableConfirmation.statusCode, 503);
        assert.equal(unavailableConfirmation.json().error.code, "OBJECT_STORAGE_UNAVAILABLE");

        const unversionedPrepared = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, importBody, {
          "idempotency-key": `${prefix}-unversioned-import`,
        }), 201);
        const unversionedInternal = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: unversionedPrepared.import.id } });
        importStorage.versioningEnabled = false;
        importStorage.put(unversionedInternal.storageKey, { bytes: workbook, mime: importBody.mime, checksum: workbookChecksum });
        const unversionedConfirmation = await call(
          "POST",
          `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${unversionedPrepared.import.id}/confirm`,
          owner.cookie,
        );
        importStorage.versioningEnabled = true;
        assert.equal(unversionedConfirmation.statusCode, 503);
        assert.equal(unversionedConfirmation.json().error.code, "IMPORT_STORAGE_IMMUTABILITY_UNAVAILABLE");
        assert.equal(
          (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: unversionedPrepared.import.id } })).status,
          "AWAITING_UPLOAD",
        );

        const internalImport = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: prepared.import.id } });
        importStorage.put(internalImport.storageKey, { bytes: workbook, mime: importBody.mime, checksum: workbookChecksum });
        const confirmed = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/confirm`, owner.cookie), 202);
        assert.equal(confirmed.status, "SECURITY_PENDING");
        assert.equal(confirmed.scanStatus, "PENDING");
        assert.equal(confirmed.progress, 10);
        assert.equal(confirmed.securityApprovedAt, null);
        assert.equal("storageVersionId" in confirmed, false);
        const pinnedImport = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: prepared.import.id } });
        assert.ok(pinnedImport.storageVersionId);
        importStorage.put(pinnedImport.storageKey, {
          bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x05]),
          mime: importBody.mime,
          checksum: workbookChecksum,
        });
        assert.equal(expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/confirm`, owner.cookie), 202).status, "SECURITY_PENDING");
        assert.equal(
          (await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: prepared.import.id } })).storageVersionId,
          pinnedImport.storageVersionId,
        );
        assert.equal((expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie), 200) as Array<{ id: string }>).some((item) => item.id === prepared.import.id), true);
        const cancelled = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/cancel`, owner.cookie), 200);
        assert.equal(cancelled.status, "CANCELLED");
        assert.equal(expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${prepared.import.id}/cancel`, owner.cookie), 200).status, "CANCELLED");

        const leasedPrepared = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, importBody, {
          "idempotency-key": `${prefix}-leased-import`,
        }), 201);
        const leasedInternal = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: leasedPrepared.import.id } });
        importStorage.put(leasedInternal.storageKey, { bytes: workbook, mime: importBody.mime, checksum: workbookChecksum });
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${leasedPrepared.import.id}/confirm`, owner.cookie), 202);
        const claimedAt = new Date();
        await prisma.northDatasetImportJob.update({
          where: { id: leasedPrepared.import.id },
          data: {
            claimedAt,
            claimExpiresAt: new Date(claimedAt.getTime() + 60_000),
            claimedBy: "integration-worker",
            claimToken: randomUUID(),
          },
        });
        const cancellationRequested = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${leasedPrepared.import.id}/cancel`, owner.cookie), 200);
        assert.equal(cancellationRequested.status, "CANCEL_REQUESTED");
        assert.equal(cancellationRequested.cancelledAt, null);

        const invalidWorkbook = Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]);
        const invalidChecksum = createHash("sha256").update(invalidWorkbook).digest("hex");
        const invalidPrepared = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, {
          ...importBody, filename: "invalid.xlsx", checksum: invalidChecksum,
        }, { "idempotency-key": `${prefix}-invalid-import` }), 201);
        const invalidInternal = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: invalidPrepared.import.id } });
        importStorage.put(invalidInternal.storageKey, { bytes: invalidWorkbook, mime: importBody.mime, checksum: invalidChecksum });
        const invalidConfirmation = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${invalidPrepared.import.id}/confirm`, owner.cookie);
        assert.equal(invalidConfirmation.statusCode, 422);
        assert.equal(invalidConfirmation.json().error.code, "IMPORT_MAGIC_INVALID");
        const rejectedImport = expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${invalidPrepared.import.id}`, owner.cookie), 200);
        assert.equal(rejectedImport.status, "REJECTED");
        assert.equal(rejectedImport.errorCode, "IMPORT_MAGIC_INVALID");

        const workerConfiguration = {
          leaseMilliseconds: 30_000,
          heartbeatMilliseconds: 1_000,
          retryDelayMilliseconds: 60_000,
          maximumBytes: 1024,
        };
        const unavailableArchive = new UnconfiguredDatasetImportArchiveValidator();
        const approvedScanner = {
          async scan(input: { openPrivateRead: () => Promise<NodeJS.ReadableStream>; signal: AbortSignal }) {
            const stream = await input.openPrivateRead();
            for await (const _chunk of stream) {
              if (input.signal.aborted) throw new Error("aborted");
            }
            return "APPROVED" as const;
          },
        };
        const prepareWorkerJob = async (suffix: string) => {
          const preparedJob = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports`, owner.cookie, importBody, {
            "idempotency-key": `${prefix}-${suffix}`,
          }), 201);
          const internal = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: preparedJob.import.id } });
          assert.equal(internal.storageKey.includes(organizationId), false);
          assert.equal(internal.storageKey.includes(dataset.id), false);
          importStorage.put(internal.storageKey, { bytes: workbook, mime: importBody.mime, checksum: workbookChecksum });
          expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${preparedJob.import.id}/confirm`, owner.cookie), 202);
          return internal;
        };

        const expiredClaimedAt = new Date(Date.now() - 120_000);
        await prisma.northDatasetImportJob.update({
          where: { id: leasedPrepared.import.id },
          data: { claimedAt: expiredClaimedAt, claimExpiresAt: new Date(expiredClaimedAt.getTime() + 30_000) },
        });
        const recoveryWorker = new NorthDatasetImportWorker("recovery-worker", {
          storage: importStorage, scanner: approvedScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        assert.equal(await recoveryWorker.runOnce(), "CANCELLED");
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: leasedPrepared.import.id } })).status, "CANCELLED");

        const storageUnavailableJob = await prepareWorkerJob("worker-storage-unavailable");
        const storageUnavailableWorker = new NorthDatasetImportWorker("storage-unavailable-worker", {
          storage: new UnavailableObjectStorage(), scanner: approvedScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        assert.equal(await storageUnavailableWorker.runOnce(), "BLOCKED");
        const storageBlocked = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: storageUnavailableJob.id } });
        assert.equal(storageBlocked.status, "SECURITY_BLOCKED");
        assert.equal(storageBlocked.lastErrorCode, "OBJECT_STORAGE_UNAVAILABLE");
        assert.equal(storageBlocked.securityApprovedAt, null);

        const scannerUnavailableJob = await prepareWorkerJob("worker-scanner-unavailable");
        const scannerUnavailableWorker = new NorthDatasetImportWorker("scanner-unavailable-worker", {
          storage: importStorage,
          scanner: new UnconfiguredDatasetImportMalwareScanner(),
          archiveValidator: unavailableArchive,
          configuration: workerConfiguration,
        });
        assert.equal(await scannerUnavailableWorker.runOnce(), "BLOCKED");
        const scannerBlocked = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: scannerUnavailableJob.id } });
        assert.equal(scannerBlocked.status, "SECURITY_BLOCKED");
        assert.equal(scannerBlocked.scanStatus, "UNAVAILABLE");
        assert.equal(scannerBlocked.lastErrorCode, "IMPORT_MALWARE_SCANNER_UNAVAILABLE");

        const archiveUnavailableJob = await prepareWorkerJob("worker-archive-unavailable");
        const abandonedAt = new Date(Date.now() - 120_000);
        await prisma.northDatasetImportJob.update({
          where: { id: archiveUnavailableJob.id },
          data: {
            claimedAt: abandonedAt,
            claimExpiresAt: new Date(abandonedAt.getTime() + 30_000),
            claimedBy: "expired-worker",
            claimToken: randomUUID(),
          },
        });
        const archiveUnavailableWorker = new NorthDatasetImportWorker("archive-unavailable-worker", {
          storage: importStorage, scanner: approvedScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        assert.equal(await archiveUnavailableWorker.runOnce(), "BLOCKED");
        const archiveBlocked = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: archiveUnavailableJob.id } });
        assert.equal(archiveBlocked.status, "SECURITY_BLOCKED");
        assert.equal(archiveBlocked.scanStatus, "APPROVED");
        assert.equal(archiveBlocked.lastErrorCode, "IMPORT_ARCHIVE_VALIDATOR_UNAVAILABLE");
        assert.equal(archiveBlocked.securityApprovedAt, null);

        const approvedJob = await prepareWorkerJob("worker-security-approved");
        const approvedArchive = {
          async validate(input: { openPrivateRead: () => Promise<NodeJS.ReadableStream>; signal: AbortSignal }) {
            const stream = await input.openPrivateRead();
            for await (const _chunk of stream) {
              if (input.signal.aborted) throw new Error("aborted");
            }
            return "APPROVED" as const;
          },
        };
        const approvingWorker = new NorthDatasetImportWorker("approving-worker", {
          storage: importStorage,
          scanner: approvedScanner,
          archiveValidator: approvedArchive,
          configuration: workerConfiguration,
        });
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        const approvedAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: approvedJob.id } });
        assert.equal(approvedAfter.status, "SECURITY_APPROVED");
        assert.equal(approvedAfter.scanStatus, "APPROVED");
        assert.ok(approvedAfter.securityApprovedAt);
        assert.equal(approvedAfter.claimToken, null);

        const analysisWorker = new NorthDatasetImportAnalysisWorker("analysis-worker", {
          async analyze() {
            return {
              parserVersion: "test-parser",
              workbook: { sheets: [{
                ordinal: 0, name: "Master House", rowCount: 3, columnCount: 2,
                columns: [
                  { ordinal: 0, header: "Duplicate", inferredType: "INTEGER", nonEmptyCount: 2, nullable: false },
                  { ordinal: 1, header: "Duplicate", inferredType: "TEXT", nonEmptyCount: 1, nullable: true },
                ],
              }] },
            };
          },
        }, { leaseMilliseconds: 30_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 60_000 });
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const analysis = expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/analysis`, owner.cookie), 200);
        assert.equal(analysis.workbook.sheets[0].columns[0].header, "Duplicate");
        assert.equal(analysis.workbook.sheets[0].columns[1].ordinal, 1);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/analysis`, outsider.cookie), 404);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/analysis`, invited.cookie), 403);
        const mappedField = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/fields`, owner.cookie, {
          key: "revenue", displayName: { en: "Revenue" }, canonicalType: "DECIMAL",
        }), 201);
        const duplicateCreate = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [
            { sourceOrdinal: 0, action: "CREATE", key: "duplicate", displayName: { en: "Duplicate one" }, canonicalType: "INTEGER" },
            { sourceOrdinal: 1, action: "CREATE", key: "duplicate", displayName: { en: "Duplicate two" }, canonicalType: "TEXT" },
          ],
        });
        assert.equal(duplicateCreate.statusCode, 422);
        assert.equal(duplicateCreate.json().error.code, "IMPORT_MAPPING_CREATE_KEY_DUPLICATE");
        const conflictingCreate = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [
            { sourceOrdinal: 0, action: "CREATE", key: "revenue", displayName: { en: "Revenue duplicate" }, canonicalType: "DECIMAL" },
            { sourceOrdinal: 1, action: "IGNORE" },
          ],
        });
        assert.equal(conflictingCreate.statusCode, 422);
        assert.equal(conflictingCreate.json().error.code, "IMPORT_MAPPING_CREATE_KEY_CONFLICT");
        const mapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [
            { sourceOrdinal: 0, action: "MAP", fieldId: mappedField.id },
            { sourceOrdinal: 1, action: "IGNORE" },
          ],
        }), 201);
        assert.equal(mapping.version, 1);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/mappings/${mapping.id}`, outsider.cookie), 404);
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: approvedJob.id } })).status, "AWAITING_MAPPING");
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/activate`, outsider.cookie, { mappingId: mapping.id, mode: "REPLACE_DATASET" }), 404);
        const activation = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${approvedJob.id}/activate`, owner.cookie, { mappingId: mapping.id, mode: "REPLACE_DATASET" }), 202);
        assert.equal(activation.status, "READY_TO_ACTIVATE");
        const materializationWorker = new NorthDatasetImportMaterializationWorker("materialization-worker", {
          async materialize(input: { columns: Array<{ fieldId: string }>; signal: AbortSignal }) {
            assert.equal(input.signal.aborted, false);
            const revenueId = input.columns[0]!.fieldId;
            return { parserVersion: "test-parser", rows: [{ [revenueId]: "10.5" }, { [revenueId]: "20" }] };
          },
        }, { leaseMilliseconds: 30_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 60_000 });
        assert.equal(await materializationWorker.runOnce(), "SUCCEEDED");
        const activatedDataset = await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } });
        assert.ok(activatedDataset.activeRevisionId);
        assert.ok(activatedDataset.currentSchemaVersionId);
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: approvedJob.id } })).status, "SUCCEEDED");
        const rowsResult = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/query`, owner.cookie, {
          mode: "ROWS", fields: [mappedField.id], limit: 10,
        }), 200);
        assert.deepEqual(rowsResult.columns, [{ key: mappedField.id, fieldId: mappedField.id, type: "DECIMAL" }]);
        assert.deepEqual(rowsResult.rows.map((row: Record<string, string>) => row[mappedField.id]), ["10.5", "20"]);
        const filteredRows = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/query`, owner.cookie, {
          mode: "ROWS", fields: [mappedField.id], filters: [{ fieldId: mappedField.id, operator: "GTE", value: "15" }], limit: 10,
        }), 200);
        assert.deepEqual(filteredRows.rows.map((row: Record<string, string>) => row[mappedField.id]), ["20"]);
        const aggregateResult = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/query`, owner.cookie, {
          mode: "AGGREGATE", measures: [{ operation: "SUM", fieldId: mappedField.id, alias: "total_revenue" }],
        }), 200);
        assert.equal(aggregateResult.rows[0].total_revenue, "30.5");
        const orderedAggregate = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/query`, owner.cookie, {
          mode: "AGGREGATE", groupBy: [mappedField.id], measures: [{ operation: "COUNT", alias: "records" }],
          orderBy: [{ key: mappedField.id, direction: "DESC" }], limit: 2,
        }), 200);
        assert.equal(orderedAggregate.rows[0][mappedField.id], "20");
        expect(await call("POST", `/v1/organizations/${secondOrg}/datasets/${dataset.id}/query`, joiner.cookie, { mode: "ROWS", fields: [mappedField.id] }), 404);
        const invalidQuery = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/query`, owner.cookie, { mode: "ROWS", fields: [randomUUID()] });
        assert.equal(invalidQuery.statusCode, 422);
        assert.equal(invalidQuery.json().error.code, "DATASET_QUERY_FIELD_INVALID");

        const analyticsCategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, { name: { en: "Analytics" }, slug: "analytics-demo" }), 201);
        const analyticsSubcategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${analyticsCategory.id}/subcategories`, owner.cookie, { name: { en: "Reports" }, slug: "analytics-reports" }), 201);
        const analyticsPanel = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${analyticsSubcategory.id}/panels`, owner.cookie, { name: { en: "Master House" }, slug: "master-house-demo" }), 201);
        const otherPanel = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${analyticsSubcategory.id}/panels`, owner.cookie, { name: { en: "Other" }, slug: "other-analytics" }), 201);
        const analyticsBinding = expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings`, owner.cookie, {
          name: "Filtered record count", datasetId: dataset.id,
          query: { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "total_records" }] },
          allowedFilters: [{ fieldId: mappedField.id, operators: ["GTE"] }],
        }), 201);
        expect(await call("GET", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings`, outsider.cookie), 404);
        const analyticsDocument = {
          schemaVersion: 1, defaultLocale: "en", fallbackLocales: [],
          sections: [{ id: "main", order: 0, layout: { variant: "grid", gap: "md" }, components: [{
            id: "table", type: "table", schemaVersion: 1,
            props: { columns: [{ key: "total_records", label: { en: "Records" } }], rows: [] },
            bindings: { rows: { sourceType: "dataset", sourceId: analyticsBinding.id, datasetId: dataset.id } },
            layout: { desktop: { x: 0, y: 0, w: 12, h: 4 }, tablet: { x: 0, y: 0, w: 12, h: 4 }, mobile: { x: 0, y: 0, w: 12, h: 4 } }, order: 0,
          }] }],
        };
        const crossPanelDraft = await call("PATCH", `/v1/organizations/${organizationId}/panels/${otherPanel.id}/draft`, owner.cookie, { document: analyticsDocument });
        assert.equal(crossPanelDraft.statusCode, 422);
        assert.equal(crossPanelDraft.json().error.code, "BINDING_NOT_ALLOWED");
        const analyticsDraft = expect(await call("PATCH", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/draft`, owner.cookie, { document: analyticsDocument }), 200);
        expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/publish`, owner.cookie, undefined, { "if-match": analyticsDraft.etag }), 200);
        const bindingResult = expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings/${analyticsBinding.id}/results`, owner.cookie, {
          filters: [{ fieldId: mappedField.id, operator: "GTE", value: "15" }],
        }), 200);
        assert.equal(bindingResult.bindingId, analyticsBinding.id);
        assert.equal(bindingResult.rows[0].total_records, "1");
        assert.deepEqual(bindingResult.filterDefinitions, [{
          fieldId: mappedField.id,
          key: mappedField.key,
          displayName: mappedField.displayName,
          type: mappedField.canonicalType,
          operators: ["GTE"],
        }]);
        const driftDataset = expect(await call("POST", `/v1/organizations/${organizationId}/datasets`, owner.cookie, {
          name: { en: "Binding drift guard" }, slug: "binding-drift-guard",
        }), 201);
        await prisma.northAnalyticsBinding.update({ where: { id: analyticsBinding.id }, data: { datasetId: driftDataset.id } });
        expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings/${analyticsBinding.id}/results`, owner.cookie, { filters: [] }), 404);
        await prisma.northAnalyticsBinding.update({ where: { id: analyticsBinding.id }, data: { datasetId: dataset.id } });
        const disallowedBindingFilter = await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings/${analyticsBinding.id}/results`, owner.cookie, {
          filters: [{ fieldId: mappedField.id, operator: "LTE", value: "15" }],
        });
        assert.equal(disallowedBindingFilter.statusCode, 422);
        assert.equal(disallowedBindingFilter.json().error.code, "BINDING_FILTER_NOT_ALLOWED");
        expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings/${analyticsBinding.id}/results`, outsider.cookie, { filters: [] }), 404);
        await prisma.northPanel.update({ where: { id: analyticsPanel.id }, data: { accessPolicyMode: "ACL_V1" } });
        expect(await call("POST", `/v1/organizations/${organizationId}/panels/${analyticsPanel.id}/analytics-bindings/${analyticsBinding.id}/results`, owner.cookie, { filters: [] }), 403);
        await prisma.northPanel.update({ where: { id: analyticsPanel.id }, data: { accessPolicyMode: "LEGACY_AUDIENCE" } });

        const retryJob = await prepareWorkerJob("materialization-retry-atomic");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const retryMapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${retryJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [
            { sourceOrdinal: 0, action: "CREATE", key: "retry_value", displayName: { en: "Retry value" }, canonicalType: "INTEGER", nullable: false },
            { sourceOrdinal: 1, action: "IGNORE" },
          ],
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${retryJob.id}/activate`, owner.cookie, { mappingId: retryMapping.id, mode: "REPLACE_DATASET" }), 202);
        let materializationCalls = 0;
        const retryWorker = new NorthDatasetImportMaterializationWorker("retry-materialization-worker", {
          async materialize(input: { columns: Array<{ fieldId: string }> }) {
            materializationCalls += 1;
            if (materializationCalls === 1) throw new Error("transient parser outage");
            return { parserVersion: "test-parser", rows: [{ [input.columns[0]!.fieldId]: 7 }] };
          },
        }, { leaseMilliseconds: 30_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 1 });
        const activeBeforeRetry = (await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId;
        assert.equal(await retryWorker.runOnce(), "READY_TO_ACTIVATE");
        assert.equal(await prisma.northDatasetImportBatch.findUnique({ where: { importId: retryJob.id } }), null);
        assert.equal(await prisma.northDatasetField.findUnique({ where: { datasetId_key: { datasetId: dataset.id, key: "retry_value" } } }), null);
        assert.equal((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, activeBeforeRetry);
        await prisma.northDatasetImportJob.update({ where: { id: retryJob.id }, data: { availableAt: new Date(Date.now() - 1_000) } });
        assert.equal(await retryWorker.runOnce(), "SUCCEEDED");
        assert.notEqual((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, activeBeforeRetry);
        const retryField = await prisma.northDatasetField.findUniqueOrThrow({ where: { datasetId_key: { datasetId: dataset.id, key: "retry_value" } } });

        const missingRequiredJob = await prepareWorkerJob("materialization-missing-required");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const missingRequiredMapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${missingRequiredJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [{ sourceOrdinal: 0, action: "MAP", fieldId: mappedField.id }, { sourceOrdinal: 1, action: "IGNORE" }],
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${missingRequiredJob.id}/activate`, owner.cookie, { mappingId: missingRequiredMapping.id, mode: "REPLACE_DATASET" }), 202);
        const activeBeforeMissingRequired = (await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId;
        assert.equal(await materializationWorker.runOnce(), "FAILED");
        const missingRequiredAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: missingRequiredJob.id } });
        assert.equal(missingRequiredAfter.lastErrorCode, "IMPORT_REQUIRED_FIELD_MISSING");
        assert.equal(await prisma.northDatasetImportBatch.findUnique({ where: { importId: missingRequiredJob.id } }), null);
        assert.equal((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, activeBeforeMissingRequired);

        const cancelReadyJob = await prepareWorkerJob("materialization-cancel-ready");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const cancelMapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${cancelReadyJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [{ sourceOrdinal: 0, action: "MAP", fieldId: mappedField.id }, { sourceOrdinal: 1, action: "MAP", fieldId: retryField.id }],
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${cancelReadyJob.id}/activate`, owner.cookie, { mappingId: cancelMapping.id, mode: "REPLACE_DATASET" }), 202);
        assert.equal(expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${cancelReadyJob.id}/cancel`, owner.cookie), 200).status, "CANCELLED");
        assert.equal(await prisma.northDatasetImportBatch.findUnique({ where: { importId: cancelReadyJob.id } }), null);

        const crashedCancellationJob = await prepareWorkerJob("materialization-expired-cancel");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const crashedCancellationMapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${crashedCancellationJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [{ sourceOrdinal: 0, action: "MAP", fieldId: mappedField.id }, { sourceOrdinal: 1, action: "IGNORE" }],
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${crashedCancellationJob.id}/activate`, owner.cookie, { mappingId: crashedCancellationMapping.id, mode: "REPLACE_DATASET" }), 202);
        const expiredMaterializationLease = new Date(Date.now() - 60_000);
        await prisma.northDatasetImportJob.update({ where: { id: crashedCancellationJob.id }, data: {
          status: "CANCEL_REQUESTED", cancellationRequestedAt: new Date(Date.now() - 120_000), claimedAt: new Date(Date.now() - 120_000),
          claimExpiresAt: expiredMaterializationLease, claimedBy: "crashed-materializer", claimToken: randomUUID(),
        } });
        assert.equal(await materializationWorker.runOnce(), "CANCELLED");
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: crashedCancellationJob.id } })).status, "CANCELLED");

        const expiredPublishJob = await prepareWorkerJob("materialization-expired-publish-lease");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const expiredPublishMapping = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${expiredPublishJob.id}/mappings`, owner.cookie, {
          sheetOrdinal: 0, headerRow: 1,
          columns: [{ sourceOrdinal: 0, action: "MAP", fieldId: mappedField.id }, { sourceOrdinal: 1, action: "MAP", fieldId: retryField.id }],
        }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${expiredPublishJob.id}/activate`, owner.cookie, { mappingId: expiredPublishMapping.id, mode: "REPLACE_DATASET" }), 202);
        const activeBeforeExpiredPublish = (await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId;
        const baseLeaseTime = Date.now();
        let clockCalls = 0;
        const expiringClock = () => new Date(baseLeaseTime + (++clockCalls >= 4 ? 31_000 : 0));
        const expiringWorker = new NorthDatasetImportMaterializationWorker("expiring-materialization-worker", {
          async materialize() { return { parserVersion: "test-parser", rows: [{ [mappedField.id]: "99", [retryField.id]: 1 }] }; },
        }, { leaseMilliseconds: 30_000, heartbeatMilliseconds: 5_000, retryDelayMilliseconds: 60_000 }, expiringClock);
        assert.equal(await expiringWorker.runOnce(), "LEASE_LOST");
        assert.equal(await prisma.northDatasetImportBatch.findUnique({ where: { importId: expiredPublishJob.id } }), null);
        assert.equal((await prisma.northDataset.findUniqueOrThrow({ where: { id: dataset.id } })).activeRevisionId, activeBeforeExpiredPublish);
        await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE TABLE "NorthDatasetImportAnalysis"'));
        await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE TABLE "NorthDatasetImportMappingVersion"'));
        await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE TABLE "NorthDatasetRow"'));
        await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE TABLE "NorthDatasetRevision"'));
        assert.ok(await prisma.northDatasetImportAnalysis.findUnique({ where: { importId: approvedJob.id } }));
        assert.ok(await prisma.northDatasetImportMappingVersion.findUnique({ where: { id: mapping.id } }));

        const expiredAnalysisJob = await prepareWorkerJob("analysis-expired-lease");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        const expiredAnalysisAt = new Date(Date.now() - 120_000);
        await prisma.northDatasetImportJob.update({
          where: { id: expiredAnalysisJob.id },
          data: {
            status: "ANALYZING",
            attempts: 2,
            claimedAt: expiredAnalysisAt,
            claimExpiresAt: new Date(expiredAnalysisAt.getTime() + 30_000),
            claimedBy: "crashed-analysis-worker",
            claimToken: randomUUID(),
          },
        });
        assert.equal(await analysisWorker.runOnce(), "AWAITING_MAPPING");
        const expiredAnalysisAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: expiredAnalysisJob.id } });
        assert.equal(expiredAnalysisAfter.status, "AWAITING_MAPPING");
        assert.equal(expiredAnalysisAfter.attempts, 3);
        assert.equal(expiredAnalysisAfter.claimToken, null);

        const exhaustedAnalysisJob = await prepareWorkerJob("analysis-retry-exhausted");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        await prisma.northDatasetImportJob.update({
          where: { id: exhaustedAnalysisJob.id },
          data: { status: "ANALYSIS_BLOCKED", attempts: 3, availableAt: new Date(Date.now() - 1_000) },
        });
        assert.equal(await analysisWorker.runOnce(), "FAILED");
        const exhaustedAnalysisAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: exhaustedAnalysisJob.id } });
        assert.equal(exhaustedAnalysisAfter.status, "FAILED");
        assert.equal(exhaustedAnalysisAfter.lastErrorCode, "IMPORT_RETRY_EXHAUSTED");

        const cancelledAnalysisJob = await prepareWorkerJob("analysis-cooperative-cancel");
        assert.equal(await approvingWorker.runOnce(), "SECURITY_APPROVED");
        let releaseAnalysis!: () => void;
        let enteredAnalysis!: () => void;
        const analysisEntered = new Promise<void>((resolve) => { enteredAnalysis = resolve; });
        const cancellableAnalysisWorker = new NorthDatasetImportAnalysisWorker("cancellable-analysis-worker", {
          async analyze() {
            enteredAnalysis();
            await new Promise<void>((resolve) => { releaseAnalysis = resolve; });
            return { parserVersion: "test-parser", workbook: { sheets: [{ ordinal: 0, name: "Sheet", rowCount: 1, columnCount: 0, columns: [] }] } };
          },
        }, { leaseMilliseconds: 30_000, heartbeatMilliseconds: 1_000, retryDelayMilliseconds: 60_000 });
        const cancellableAnalysisRun = cancellableAnalysisWorker.runOnce();
        await analysisEntered;
        assert.equal(expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${cancelledAnalysisJob.id}/cancel`, owner.cookie), 200).status, "CANCEL_REQUESTED");
        releaseAnalysis();
        assert.equal(await cancellableAnalysisRun, "CANCELLED");
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: cancelledAnalysisJob.id } })).status, "CANCELLED");

        const exhaustedJob = await prepareWorkerJob("worker-retry-exhausted");
        const exhaustedAt = new Date(Date.now() - 120_000);
        await prisma.northDatasetImportJob.update({
          where: { id: exhaustedJob.id },
          data: {
            attempts: 3,
            claimedAt: exhaustedAt,
            claimExpiresAt: new Date(exhaustedAt.getTime() + 30_000),
            claimedBy: "crashed-worker",
            claimToken: randomUUID(),
          },
        });
        const exhaustedRecoveryWorker = new NorthDatasetImportWorker("exhausted-recovery-worker", {
          storage: importStorage, scanner: approvedScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        assert.equal(await exhaustedRecoveryWorker.runOnce(), "FAILED");
        const exhaustedAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: exhaustedJob.id } });
        assert.equal(exhaustedAfter.status, "FAILED");
        assert.equal(exhaustedAfter.lastErrorCode, "IMPORT_RETRY_EXHAUSTED");

        const workerMismatchJob = await prepareWorkerJob("worker-stream-mismatch");
        importStorage.put(workerMismatchJob.storageKey, {
          bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x05]),
          mime: importBody.mime,
          checksum: workbookChecksum,
        });
        const mismatchWorker = new NorthDatasetImportWorker("mismatch-worker", {
          storage: importStorage, scanner: approvedScanner, archiveValidator: approvedArchive, configuration: workerConfiguration,
        });
        assert.equal(await mismatchWorker.runOnce(), "SECURITY_APPROVED");
        const mismatchApproved = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: workerMismatchJob.id } });
        assert.equal(mismatchApproved.status, "SECURITY_APPROVED");
        assert.equal(mismatchApproved.lastErrorCode, null);

        const cooperativeJob = await prepareWorkerJob("worker-cooperative-cancel");
        let releaseCooperative!: () => void;
        let enteredCooperative!: () => void;
        const cooperativeEntered = new Promise<void>((resolve) => { enteredCooperative = resolve; });
        const cooperativeScanner = {
          scan: async () => {
            enteredCooperative();
            await new Promise<void>((resolve) => { releaseCooperative = resolve; });
            return "APPROVED" as const;
          },
        };
        const cooperativeWorker = new NorthDatasetImportWorker("cooperative-worker", {
          storage: importStorage, scanner: cooperativeScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        const cooperativeRun = cooperativeWorker.runOnce();
        await cooperativeEntered;
        assert.equal(expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/imports/${cooperativeJob.id}/cancel`, owner.cookie), 200).status, "CANCEL_REQUESTED");
        releaseCooperative();
        assert.equal(await cooperativeRun, "CANCELLED");
        assert.equal((await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: cooperativeJob.id } })).status, "CANCELLED");

        const fencedJob = await prepareWorkerJob("worker-fenced-write");
        let releaseFenced!: () => void;
        let enteredFenced!: () => void;
        const fencedEntered = new Promise<void>((resolve) => { enteredFenced = resolve; });
        const fencedScanner = {
          scan: async () => {
            enteredFenced();
            await new Promise<void>((resolve) => { releaseFenced = resolve; });
            return "APPROVED" as const;
          },
        };
        const fencedWorker = new NorthDatasetImportWorker("fenced-worker", {
          storage: importStorage, scanner: fencedScanner, archiveValidator: unavailableArchive, configuration: workerConfiguration,
        });
        const fencedRun = fencedWorker.runOnce();
        await fencedEntered;
        const stolenToken = randomUUID();
        await prisma.northDatasetImportJob.update({ where: { id: fencedJob.id }, data: { claimToken: stolenToken } });
        releaseFenced();
        assert.equal(await fencedRun, "LEASE_LOST");
        const fencedAfter = await prisma.northDatasetImportJob.findUniqueOrThrow({ where: { id: fencedJob.id } });
        assert.equal(fencedAfter.claimToken, stolenToken);
        assert.equal(fencedAfter.status, "SECURITY_PENDING");
        assert.equal(fencedAfter.securityApprovedAt, null);

        const foreignPrincipal = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/acl`, owner.cookie, {
          effect: "ALLOW",
          principalType: "MEMBERSHIP",
          membershipId: foreignMembership.id,
        });
        assert.equal(foreignPrincipal.statusCode, 422);
        assert.equal(foreignPrincipal.json().error.code, "ACL_PRINCIPAL_INVALID");

        const invitedDeny = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/acl`, owner.cookie, {
          effect: "DENY",
          principalType: "MEMBERSHIP",
          membershipId: invitedMembership.id,
        }), 201);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, invited.cookie), 403);

        const lockout = await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/acl`, owner.cookie, {
          effect: "DENY",
          principalType: "ROLE",
          role: "OWNER",
        });
        assert.equal(lockout.statusCode, 409);
        assert.equal(lockout.json().error.code, "ACL_LOCKOUT_PREVENTED");
        expect(await call("DELETE", `/v1/organizations/${organizationId}/datasets/${dataset.id}/acl/${invitedDeny.id}`, owner.cookie), 200);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, invited.cookie), 200);
        expect(await call("PATCH", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, owner.cookie, { status: "ARCHIVED" }), 200);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, invited.cookie), 404);
        expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, owner.cookie), 200);
        expect(await call("PATCH", `/v1/organizations/${organizationId}/datasets/${dataset.id}`, owner.cookie, { status: "ACTIVE" }), 200);

        const arrival = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/fields`, owner.cookie, {
          key: "arrival_date",
          displayName: { en: "Arrival date" },
          canonicalType: "DATE",
          nullable: false,
        }), 201);
        const containers = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/fields`, owner.cookie, {
          key: "containers",
          displayName: { en: "Containers" },
          canonicalType: "INTEGER",
          nullable: true,
        }), 201);
        const schema = expect(await call("POST", `/v1/organizations/${organizationId}/datasets/${dataset.id}/schema-versions`, owner.cookie, {
          fields: [
            { fieldId: arrival.id, ordinal: 0 },
            { fieldId: containers.id, ordinal: 1 },
          ],
        }), 201);
        assert.equal(schema.version, 3);
        assert.deepEqual(schema.fields.map((field: { datasetFieldId: string }) => field.datasetFieldId), [arrival.id, containers.id]);

        expect(await call("PATCH", `/v1/organizations/${organizationId}/datasets/${dataset.id}/fields/${containers.id}`, owner.cookie, {
          nullable: false,
          displayName: { en: "Container count" },
        }), 200);
        const snapshot = expect(await call("GET", `/v1/organizations/${organizationId}/datasets/${dataset.id}/schema-versions/${schema.id}`, owner.cookie), 200);
        assert.equal(snapshot.fields.find((field: { datasetFieldId: string }) => field.datasetFieldId === containers.id)?.nullable, true);
        await assert.rejects(prisma.northDatasetSchemaVersion.update({
          where: { id: schema.id },
          data: { version: 2 },
        }));
      },
    );
    await t.test(
      "NORTH taxonomy, aliases, scoped grants, audiences, and tenant isolation",
      async () => {
        const bootstrapped = await prisma.northCategory.findMany({ where: { organizationId } });
        assert.equal(bootstrapped.filter((item) => item.resourceKind === "SYSTEM").length, 2);
        await (await import("../src/modules/north/service.js")).northTaxonomy.ensureBootstrap(organizationId);
        assert.equal(await prisma.northCategory.count({ where: { organizationId, resourceKind: "SYSTEM" } }), 2);

        const finance = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, {
          name: { en: "Finance", es: "Finanzas" }, slug: "finance",
        }), 201);
        const hr = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, {
          name: { en: "HR" }, slug: "human-resources",
        }), 201);
        const reports = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${finance.id}/subcategories`, owner.cookie, {
          name: { en: "Reports" }, slug: "reports",
        }), 201);
        const hrReports = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${hr.id}/subcategories`, owner.cookie, {
          name: { en: "Reports" }, slug: "reports",
        }), 201);
        const monthly = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${reports.id}/panels`, owner.cookie, {
          name: { en: "Monthly summary" }, slug: "monthly-summary",
        }), 201);
        const confidential = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${hrReports.id}/panels`, owner.cookie, {
          name: { en: "People" }, slug: "people",
        }), 201);
        const managementTree = expect(await call("GET", `/v1/organizations/${organizationId}/north/management-tree`, owner.cookie), 200);
        const managementCategories = managementTree as Array<{
          id: string; order: number; organizationId: string;
          subcategories: Array<{
            id: string; order: number; organizationId: string;
            panels: Array<{ id: string; order: number; organizationId: string; status: string }>;
          }>;
        }>;
        assert.ok(managementCategories.flatMap((category) => category.subcategories).flatMap((subcategory) => subcategory.panels).some((panel) => panel.id === monthly.id && panel.status === "DRAFT"));
        assert.deepEqual(
          managementCategories.map(({ order, id }) => [order, id]),
          managementCategories.map(({ order, id }) => [order, id]).toSorted(([leftOrder, leftId], [rightOrder, rightId]) => Number(leftOrder) - Number(rightOrder) || String(leftId).localeCompare(String(rightId))),
        );
        for (const category of managementCategories) {
          assert.equal(category.organizationId, organizationId);
          assert.deepEqual(
            category.subcategories.map(({ order, id }) => [order, id]),
            category.subcategories.map(({ order, id }) => [order, id]).toSorted(([leftOrder, leftId], [rightOrder, rightId]) => Number(leftOrder) - Number(rightOrder) || String(leftId).localeCompare(String(rightId))),
          );
          for (const subcategory of category.subcategories) {
            assert.equal(subcategory.organizationId, organizationId);
            assert.deepEqual(
              subcategory.panels.map(({ order, id }) => [order, id]),
              subcategory.panels.map(({ order, id }) => [order, id]).toSorted(([leftOrder, leftId], [rightOrder, rightId]) => Number(leftOrder) - Number(rightOrder) || String(leftId).localeCompare(String(rightId))),
            );
            for (const panel of subcategory.panels) assert.equal(panel.organizationId, organizationId);
          }
        }
        expect(await call("GET", `/v1/organizations/${organizationId}/north/management-tree`, invited.cookie), 403);
        expect(await call("GET", `/v1/organizations/${organizationId}/north/management-tree`, outsider.cookie), 404);
        expect(await call("GET", `/v1/organizations/${secondOrg}/north/management-tree`, owner.cookie), 404);
        const draftNavigation = expect(await call("GET", `/v1/organizations/${organizationId}/navigation`, owner.cookie), 200);
        assert.equal(JSON.stringify(draftNavigation).includes(monthly.id), false, "ordinary navigation never exposes draft panel metadata");
        const cloned = expect(await call("POST", `/v1/organizations/${organizationId}/north/clone`, owner.cookie, {
          kind: "PANEL", sourceId: monthly.id, destinationParentId: reports.id, slug: "monthly-copy",
        }), 201);
        assert.notEqual(cloned.id, monthly.id);
        assert.equal(cloned.status, "DRAFT");
        const editors = expect(await call("POST", `/v1/organizations/${organizationId}/groups`, owner.cookie, { name: "Finance scoped editors" }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/groups/${editors.id}/members`, owner.cookie, { userId: invited.id }), 201);
        const groupGrant = expect(await call("POST", `/v1/organizations/${organizationId}/north/permission-grants`, owner.cookie, {
          subjectType: "GROUP", groupId: editors.id, capability: "north.panel.update", scope: "CATEGORY", resourceId: finance.id,
        }), 201);
        assert.equal(groupGrant.categoryId, finance.id);
        expect(await call("PATCH", `/v1/organizations/${organizationId}/panels/${monthly.id}`, invited.cookie, { name: { en: "Monthly report" } }), 200);
        expect(await call("PATCH", `/v1/organizations/${organizationId}/panels/${confidential.id}`, invited.cookie, { name: { en: "Leaked" } }), 403);

        const invitedMembership = await prisma.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId, userId: invited.id } } });
        expect(await call("POST", `/v1/organizations/${organizationId}/north/permission-grants`, owner.cookie, {
          subjectType: "MEMBERSHIP", membershipId: invitedMembership.id, capability: "north.permission.manage", scope: "ORGANIZATION",
        }), 201);
        const permissionSubjects = expect(await call("GET", `/v1/organizations/${organizationId}/north/permission-subjects`, owner.cookie), 200);
        assert.deepEqual(permissionSubjects.roles, ["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER"]);
        assert.equal(permissionSubjects.groups.find((group: { id: string }) => group.id === editors.id)?.name, "Finance scoped editors");
        const invitedSubject = permissionSubjects.memberships.find((membership: { id: string }) => membership.id === invitedMembership.id);
        assert.ok(invitedSubject);
        assert.equal(invitedSubject?.name, "invited");
        assert.equal("email" in invitedSubject, false);
        expect(await call("GET", `/v1/organizations/${organizationId}/north/permission-subjects`, invited.cookie), 403);
        expect(await call("GET", `/v1/organizations/${organizationId}/north/permission-subjects`, outsider.cookie), 404);
        const escalation = await call("POST", `/v1/organizations/${organizationId}/north/permission-grants`, invited.cookie, {
          subjectType: "MEMBERSHIP", membershipId: invitedMembership.id, capability: "north.panel.publish", scope: "CATEGORY", resourceId: finance.id,
        });
        assert.equal(escalation.statusCode, 403);
        assert.equal(escalation.json().error.code, "PRIVILEGE_ESCALATION");

        const documentOne = {
          schemaVersion: 1,
          defaultLocale: "en",
          fallbackLocales: ["es"],
          sections: [{
            id: "main", order: 0, layout: { variant: "grid", gap: "md" },
            components: [
              { id: "title", type: "heading", schemaVersion: 1, props: { text: { en: "Monthly report", es: "Reporte mensual" }, level: 1 }, bindings: {}, layout: { desktop: { x: 0, y: 0, w: 12, h: 1 }, tablet: { x: 0, y: 0, w: 12, h: 1 }, mobile: { x: 0, y: 0, w: 12, h: 1 } }, order: 0 },
              { id: "body", type: "rich_text", schemaVersion: 1, props: { documents: { en: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "First immutable snapshot" }] }] } } }, bindings: {}, layout: { desktop: { x: 0, y: 1, w: 8, h: 2 }, tablet: { x: 0, y: 1, w: 12, h: 2 }, mobile: { x: 0, y: 1, w: 12, h: 2 } }, order: 1 },
              { id: "table", type: "table", schemaVersion: 1, props: { columns: [{ key: "total", label: { en: "Total" } }], rows: [{ total: 42 }] }, bindings: {}, layout: { desktop: { x: 8, y: 1, w: 4, h: 2 }, tablet: { x: 0, y: 3, w: 12, h: 2 }, mobile: { x: 0, y: 3, w: 12, h: 2 } }, order: 2 },
            ],
          }],
        };
        const firstDraftResponse = await call("PATCH", `/v1/organizations/${organizationId}/panels/${monthly.id}/draft`, owner.cookie, { document: documentOne, message: "First draft" });
        const firstDraft = expect(firstDraftResponse, 200);
        assert.equal(firstDraft.revisionNumber, 1);
        assert.equal(firstDraftResponse.headers.etag, firstDraft.etag);
        expect(await call("GET", `/v1/content/resolve?organizationSlug=${prefix}-alpha&categorySlug=finance&subcategorySlug=reports&panelSlug=monthly-summary`, invited.cookie), 404);
        expect(await call("GET", `/v1/organizations/${organizationId}/panels/${monthly.id}/draft`, invited.cookie), 403);
        const secondDocument = structuredClone(documentOne);
        secondDocument.sections[0]!.components[1]!.props.documents.en.content[0]!.content[0]!.text = "Second immutable snapshot";
        const secondDraftResponse = await call("PATCH", `/v1/organizations/${organizationId}/panels/${monthly.id}/draft`, owner.cookie, { document: secondDocument, message: "Autosave" }, { "if-match": firstDraft.etag });
        const secondDraft = expect(secondDraftResponse, 200);
        assert.equal(secondDraft.revisionNumber, 2);
        const published = expect(await call("POST", `/v1/organizations/${organizationId}/panels/${monthly.id}/publish`, owner.cookie, undefined, { "if-match": secondDraft.etag }), 200);
        assert.equal(published.id, secondDraft.id);
        const stale = expect(await call("PATCH", `/v1/organizations/${organizationId}/panels/${monthly.id}/draft`, owner.cookie, { document: documentOne }, { "if-match": firstDraft.etag }), 409);
        assert.equal(stale.error.code, "REVISION_CONFLICT");
        assert.equal(stale.error.currentRevision, 2);
        assert.equal(stale.error.currentETag, secondDraft.etag);
        const history = expect(await call("GET", `/v1/organizations/${organizationId}/panels/${monthly.id}/revisions`, owner.cookie), 200);
        assert.deepEqual(history.map((entry: { revisionNumber: number }) => entry.revisionNumber), [2, 1]);
        const restored = expect(await call("POST", `/v1/organizations/${organizationId}/panels/${monthly.id}/revisions/${firstDraft.id}/restore`, owner.cookie, { message: "Restore without publishing" }, { "if-match": secondDraft.etag }), 201);
        assert.equal(restored.revisionNumber, 3);
        const deepClone = expect(await call("POST", `/v1/organizations/${organizationId}/north/clone`, owner.cookie, {
          kind: "PANEL", sourceId: monthly.id, destinationParentId: reports.id, slug: "monthly-content-copy",
        }), 201);
        const clonedPanel = await prisma.northPanel.findUniqueOrThrow({ where: { id: deepClone.id }, include: { draftRevision: true } });
        assert.ok(clonedPanel.draftRevision);
        assert.equal(clonedPanel.status, "DRAFT");
        const sourceDocument = restored.document as { sections: Array<{ id: string; components: Array<{ id: string }> }> };
        const clonedDocument = clonedPanel.draftRevision.document as unknown as { sections: Array<{ id: string; components: Array<{ id: string }> }> };
        assert.notEqual(clonedDocument.sections[0]!.id, sourceDocument.sections[0]!.id);
        assert.notEqual(clonedDocument.sections[0]!.components[0]!.id, sourceDocument.sections[0]!.components[0]!.id);
        assert.equal((await prisma.northPanel.findUniqueOrThrow({ where: { id: monthly.id } })).publishedRevisionId, secondDraft.id);
        assert.equal((await prisma.northPanelRevision.findUniqueOrThrow({ where: { id: secondDraft.id } })).document instanceof Object, true);
        await assert.rejects(prisma.northPanelRevision.update({ where: { id: firstDraft.id }, data: { message: "mutated" } }));
        await assert.rejects(prisma.northPanelRevision.delete({ where: { id: firstDraft.id } }));
        expect(await call("PUT", `/v1/organizations/${organizationId}/panels/${monthly.id}/audience`, owner.cookie, { type: "GROUPS", groupIds: [editors.id] }), 200);
        const audience = expect(await call("GET", `/v1/organizations/${organizationId}/panels/${monthly.id}/audience`, owner.cookie), 200);
        assert.deepEqual(audience, { type: "GROUPS", roles: [], groupIds: [editors.id], capabilities: [], membershipIds: [] });
        expect(await call("GET", `/v1/organizations/${organizationId}/panels/${confidential.id}/audience`, invited.cookie), 403);
        expect(await call("GET", `/v1/organizations/${secondOrg}/panels/${monthly.id}/audience`, outsider.cookie), 404);
        const renamed = expect(await call("PATCH", `/v1/organizations/${organizationId}/categories/${finance.id}`, owner.cookie, { slug: "money" }), 200);
        assert.equal(renamed.id, finance.id);
        const resolved = expect(await call("GET", `/v1/content/resolve?organizationSlug=${prefix}-alpha&categorySlug=finance&subcategorySlug=reports&panelSlug=monthly-summary&locale=fr`, invited.cookie), 200);
        assert.match(resolved.canonicalPath, /\/money\/reports\/monthly-summary$/);
        assert.equal(resolved.revision.id, secondDraft.id);
        assert.equal(resolved.revision.locale.requested, "fr");
        assert.equal(resolved.revision.locale.resolved, "en");
        expect(await call("GET", `/v1/content/resolve?organizationSlug=${prefix}-alpha&categorySlug=finance&subcategorySlug=reports&panelSlug=monthly-summary`, outsider.cookie), 404);

        const archivedCategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, { name: { en: "Archived destination" }, slug: "archived-destination" }), 201);
        const archivedSubcategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${archivedCategory.id}/subcategories`, owner.cookie, { name: { en: "Archived child" }, slug: "archived-child" }), 201);
        expect(await call("POST", `/v1/organizations/${organizationId}/categories/${archivedCategory.id}/archive`, owner.cookie), 200);
        assert.equal((await call("POST", `/v1/organizations/${organizationId}/categories/${archivedCategory.id}/subcategories`, owner.cookie, { name: { en: "Rejected" }, slug: "rejected" })).json().error.code, "RESOURCE_ARCHIVED");
        assert.equal((await call("PATCH", `/v1/organizations/${organizationId}/subcategories/${reports.id}`, owner.cookie, { categoryId: archivedCategory.id })).json().error.code, "RESOURCE_ARCHIVED");
        assert.equal((await call("POST", `/v1/organizations/${organizationId}/north/clone`, owner.cookie, { kind: "SUBCATEGORY", sourceId: reports.id, destinationParentId: archivedCategory.id, slug: "rejected-copy" })).json().error.code, "RESOURCE_ARCHIVED");
        expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${archivedSubcategory.id}/archive`, owner.cookie), 200);
        const managementTreeWithArchived = expect(await call("GET", `/v1/organizations/${organizationId}/north/management-tree`, owner.cookie), 200) as Array<{
          id: string; status: string; subcategories: Array<{ id: string; status: string }>;
        }>;
        const archivedManagementCategory = managementTreeWithArchived.find((category) => category.id === archivedCategory.id);
        assert.equal(archivedManagementCategory?.status, "ARCHIVED");
        assert.equal(archivedManagementCategory?.subcategories.find((subcategory) => subcategory.id === archivedSubcategory.id)?.status, "ARCHIVED");
        assert.equal((await call("POST", `/v1/organizations/${organizationId}/subcategories/${archivedSubcategory.id}/panels`, owner.cookie, { name: { en: "Rejected" }, slug: "rejected" })).json().error.code, "RESOURCE_ARCHIVED");
        assert.equal((await call("POST", `/v1/organizations/${organizationId}/north/clone`, owner.cookie, { kind: "PANEL", sourceId: monthly.id, destinationParentId: archivedSubcategory.id, slug: "rejected-panel-copy" })).json().error.code, "RESOURCE_ARCHIVED");

        const previousCategoryLimit = process.env.NORTH_CATEGORY_LIMIT;
        process.env.NORTH_CATEGORY_LIMIT = "1";
        const limitedClone = await call("POST", `/v1/organizations/${organizationId}/north/clone`, owner.cookie, { kind: "CATEGORY", sourceId: finance.id, slug: "over-limit-copy" });
        assert.equal(limitedClone.statusCode, 409);
        assert.equal(limitedClone.json().error.code, "NORTH_CATEGORY_LIMIT_EXCEEDED");
        if (previousCategoryLimit === undefined) delete process.env.NORTH_CATEGORY_LIMIT; else process.env.NORTH_CATEGORY_LIMIT = previousCategoryLimit;

        expect(await call("POST", `/v1/organizations/${organizationId}/north/reorder`, owner.cookie, { kind: "CATEGORY", ids: [hr.id, finance.id] }), 200);
        expect(await call("PATCH", `/v1/organizations/${secondOrg}/panels/${monthly.id}`, outsider.cookie, { name: { en: "Cross tenant" } }), 404);
        expect(await call("GET", `/v1/organizations/${secondOrg}/panels/${monthly.id}/revisions/${firstDraft.id}`, outsider.cookie), 404);
        await assert.rejects(prisma.northGroupGrant.create({ data: {
          organizationId: secondOrg, groupId: editors.id, capability: "north.panel.read", scope: "ORGANIZATION",
        } }));
      },
    );
    await t.test(
      "NORTH assets validate, scan, authorize, reserve quota, and never expose storage keys",
      async () => {
        const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
        const checksum = createHash("sha256").update(png).digest("hex");
        const requested = expect(await call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, {
          filename: "chart.png", mime: "image/png", size: png.length, checksum,
        }), 201);
        assert.equal("storageKey" in requested.asset, false);
        assert.equal(requested.upload.method, "PUT");
        const stored = await prisma.northAsset.findUniqueOrThrow({ where: { id: requested.asset.id } });
        assetStorage.put(stored.storageKey, { bytes: png, mime: "image/png", checksum });
        expect(await call("GET", `/v1/organizations/${organizationId}/assets/${stored.id}/read`, owner.cookie), 404);
        const ready = expect(await call("POST", `/v1/organizations/${organizationId}/assets/${stored.id}/confirm`, owner.cookie), 200);
        assert.equal(ready.status, "READY");
        const read = expect(await call("GET", `/v1/organizations/${organizationId}/assets/${stored.id}/read`, owner.cookie), 200);
        assert.equal(read.download.method, "GET");
        assert.equal("storageKey" in read.asset, false);
        expect(await call("GET", `/v1/organizations/${organizationId}/assets/${stored.id}/read`, invited.cookie), 403);
        expect(await call("GET", `/v1/organizations/${secondOrg}/assets/${stored.id}/read`, outsider.cookie), 404);

        const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
        assert.equal(organization.storageUsedBytes, BigInt(png.length));
        assert.equal(organization.storageReservedBytes, 0n);

        await prisma.organization.update({
          where: { id: organizationId },
          data: { storageLimitBytes: organization.storageUsedBytes + BigInt(png.length) },
        });
        const concurrent = await Promise.all([
          call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, { filename: "quota-a.png", mime: "image/png", size: png.length, checksum }),
          call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, { filename: "quota-b.png", mime: "image/png", size: png.length, checksum }),
        ]);
        assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 409]);
        assert.equal(concurrent.find((response) => response.statusCode === 409)!.json().error.code, "QUOTA_EXCEEDED");
        const reservedUpload = concurrent.find((response) => response.statusCode === 201)!.json().asset;
        expect(await call("DELETE", `/v1/organizations/${organizationId}/assets/${reservedUpload.id}`, owner.cookie), 200);
        await prisma.organization.update({ where: { id: organizationId }, data: { storageLimitBytes: 10n * 1024n * 1024n * 1024n } });

        const rejectedRequest = expect(await call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, {
          filename: "spoof.png", mime: "image/png", size: png.length, checksum,
        }), 201);
        const rejectedRow = await prisma.northAsset.findUniqueOrThrow({ where: { id: rejectedRequest.asset.id } });
        assetStorage.put(rejectedRow.storageKey, { bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5, 6, 7]), mime: "image/png", checksum });
        const spoofed = await call("POST", `/v1/organizations/${organizationId}/assets/${rejectedRow.id}/confirm`, owner.cookie);
        assert.equal(spoofed.statusCode, 422);
        assert.equal(spoofed.json().error.code, "ASSET_MAGIC_MISMATCH");
        assert.equal((await prisma.northAsset.findUniqueOrThrow({ where: { id: rejectedRow.id } })).status, "REJECTED");

        assetScanner.verdict = "QUARANTINED";
        const quarantineRequest = expect(await call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, {
          filename: "suspect.png", mime: "image/png", size: png.length, checksum,
        }), 201);
        const quarantineRow = await prisma.northAsset.findUniqueOrThrow({ where: { id: quarantineRequest.asset.id } });
        assetStorage.put(quarantineRow.storageKey, { bytes: png, mime: "image/png", checksum });
        const quarantined = await call("POST", `/v1/organizations/${organizationId}/assets/${quarantineRow.id}/confirm`, owner.cookie);
        assert.equal(quarantined.statusCode, 422);
        assert.equal(quarantined.json().error.code, "ASSET_QUARANTINED");
        assetScanner.verdict = "REJECTED";
        const malwareRequest = expect(await call("POST", `/v1/organizations/${organizationId}/assets/uploads`, owner.cookie, {
          filename: "malware.png", mime: "image/png", size: png.length, checksum,
        }), 201);
        const malwareRow = await prisma.northAsset.findUniqueOrThrow({ where: { id: malwareRequest.asset.id } });
        assetStorage.put(malwareRow.storageKey, { bytes: png, mime: "image/png", checksum });
        const malwareRejected = await call("POST", `/v1/organizations/${organizationId}/assets/${malwareRow.id}/confirm`, owner.cookie);
        assert.equal(malwareRejected.statusCode, 422);
        assert.equal(malwareRejected.json().error.code, "MALWARE_REJECTED");
        assert.equal((await prisma.northAsset.findUniqueOrThrow({ where: { id: malwareRow.id } })).status, "REJECTED");
        assert.equal(assetStorage.objects.has(malwareRow.storageKey), false);
        assetScanner.verdict = "APPROVED";

        const assetCategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories`, owner.cookie, {
          name: { en: "Asset validation" }, slug: `asset-validation-${prefix}`,
        }), 201);
        const assetSubcategory = expect(await call("POST", `/v1/organizations/${organizationId}/categories/${assetCategory.id}/subcategories`, owner.cookie, {
          name: { en: "Documents" }, slug: "documents",
        }), 201);
        const assetPanel = expect(await call("POST", `/v1/organizations/${organizationId}/subcategories/${assetSubcategory.id}/panels`, owner.cookie, {
          name: { en: "Asset panel" }, slug: "asset-panel",
        }), 201);
        const assetDocument = {
          schemaVersion: 1, defaultLocale: "en", fallbackLocales: [],
          sections: [{ id: "assets", order: 0, layout: { variant: "grid", gap: "md" }, components: [{
            id: "image", type: "image", schemaVersion: 1,
            props: { assetId: stored.id, alt: { en: "Chart" } }, bindings: {}, order: 0,
            layout: { desktop: { x: 0, y: 0, w: 12, h: 2 }, tablet: { x: 0, y: 0, w: 12, h: 2 }, mobile: { x: 0, y: 0, w: 12, h: 2 } },
          }] }],
        };
        const assetDraft = expect(await call("PATCH", `/v1/organizations/${organizationId}/panels/${assetPanel.id}/draft`, owner.cookie, { document: assetDocument }), 200);

        const beforeRollback = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
        const rollbackService = new NorthAssetService({
          storage: assetStorage,
          scanner: assetScanner,
          config: assetConfiguration(),
          appendAudit: async () => { throw new Error("audit unavailable"); },
        });
        await assert.rejects(rollbackService.requestUpload(owner.id, organizationId, {
          filename: "rollback.png", mime: "image/png", size: png.length, checksum,
        }));
        const afterRollback = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
        assert.equal(afterRollback.storageReservedBytes, beforeRollback.storageReservedBytes);
        assert.equal(await prisma.northAsset.count({ where: { organizationId, filename: "rollback.png" } }), 0);

        expect(await call("DELETE", `/v1/organizations/${organizationId}/assets/${stored.id}`, owner.cookie), 200);
        expect(await call("GET", `/v1/organizations/${organizationId}/assets/${stored.id}/read`, owner.cookie), 404);
        const deletedPublish = await call("POST", `/v1/organizations/${organizationId}/panels/${assetPanel.id}/publish`, owner.cookie, undefined, { "if-match": assetDraft.etag });
        assert.equal(deletedPublish.statusCode, 422);
        assert.equal(deletedPublish.json().error.code, "CROSS_TENANT_RESOURCE");
        assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).storageUsedBytes, 0n);
      },
    );
    await t.test(
      "platform administration and deterministic organization billing remain separate from tenant access",
      async () => {
        await prisma.user.update({
          where: { id: owner.id },
          data: { role: "SUPERADMIN" },
        });
        await prisma.user.update({
          where: { id: invited.id },
          data: { role: "ADMIN" },
        });
        expect(await call("POST", `/v1/platform/users/${invited.id}/north-capabilities`, owner.cookie, {
          capability: "north.content.manage_all_tenants",
        }), 201);
        expect(await call("POST", `/v1/organizations/${secondOrg}/categories`, invited.cookie, {
          name: { en: "Operator managed" }, slug: "operator-managed",
        }), 201);
        expect(await call("DELETE", `/v1/platform/users/${invited.id}/north-capabilities/north.content.manage_all_tenants`, owner.cookie), 200);
        expect(await call("POST", `/v1/organizations/${secondOrg}/categories`, invited.cookie, {
          name: { en: "Denied operator" }, slug: "denied-operator",
        }), 403);

        const usersPage = expect(
          await call(
            "GET",
            `/v1/platform/users?q=${encodeURIComponent(invited.email)}&limit=1`,
            invited.cookie,
          ),
          200,
        );
        assert.equal(usersPage.items.length, 1);
        assert.equal(usersPage.items[0].id, invited.id);
        assert.equal("adminSecretHash" in usersPage.items[0], false);
        expect(
          await call(
            "PATCH",
            `/v1/platform/users/${outsider.id}/status`,
            invited.cookie,
            { status: "SUSPENDED" },
          ),
          403,
        );

        const beforeProvisionMail = messages.length;
        const provisioned = expect(
          await call(
            "POST",
            "/v1/platform/users/preprovision",
            owner.cookie,
            {
              name: "Provisioned operator",
              email: `${prefix}-provisioned@blackpolar.test`,
              role: "ADMIN",
            },
          ),
          201,
        );
        assert.equal(provisioned.user.passwordChangeRequired, true);
        assert.equal(provisioned.user.emailVerified, false);
        assert.equal("password" in provisioned, false);
        assert.equal("temporaryPassword" in provisioned, false);
        assert.equal(provisioned.delivery, "sent");
        assert.equal(messages.length, beforeProvisionMail + 2);
        assert.match(messages.at(-2)!, /Temporary password:/i);

        expect(
          await call(
            "PATCH",
            `/v1/platform/users/${outsider.id}/status`,
            owner.cookie,
            { status: "SUSPENDED" },
          ),
          200,
        );
        expect(await call("GET", "/v1/me", outsider.cookie), 401);
        expect(
          await call(
            "PATCH",
            `/v1/platform/users/${outsider.id}/status`,
            owner.cookie,
            { status: "ACTIVE" },
          ),
          200,
        );
        const outsiderLogin = await app.inject({
          method: "POST",
          url: "/v1/auth/sign-in/email",
          remoteAddress: "127.0.0.60",
          headers: { origin: "http://localhost:3000" },
          payload: { email: outsider.email, password },
        });
        expect(outsiderLogin, 200);
        outsider.cookie = cookieOf(outsiderLogin);

        const activeLifecycleSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(activeLifecycleSummary.byStatusScope, "ALL_PROFILES");
        expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "SUSPENDED" },
          ),
          200,
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}`,
            owner.cookie,
          ),
          403,
        );
        const suspendedBilling = expect(
          await call(
            "GET",
            `/v1/platform/organizations/${organizationId}/billing`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(suspendedBilling.status, "ACTIVE");
        assert.equal(suspendedBilling.basePriceMinor, 1400);
        assert.equal(suspendedBilling.memberPriceMinor, 500);
        assert.equal(suspendedBilling.billableMemberCount, 0);
        assert.equal(suspendedBilling.estimatedMonthlyMinor, 0);
        const suspendedSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(
          suspendedSummary.organizationCount,
          activeLifecycleSummary.organizationCount - 1,
        );
        assert.equal(
          suspendedSummary.billableMemberCount,
          activeLifecycleSummary.billableMemberCount - 4,
        );
        assert.equal(
          suspendedSummary.estimatedMonthlyMinor,
          activeLifecycleSummary.estimatedMonthlyMinor - 3400,
        );
        expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "ACTIVE" },
          ),
          200,
        );
        const restoredLifecycleBilling = expect(
          await call(
            "GET",
            `/v1/platform/organizations/${organizationId}/billing`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(restoredLifecycleBilling.billableMemberCount, 4);
        assert.equal(restoredLifecycleBilling.estimatedMonthlyMinor, 3400);
        const restoredLifecycleSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(
          restoredLifecycleSummary.organizationCount,
          activeLifecycleSummary.organizationCount,
        );
        assert.equal(
          restoredLifecycleSummary.billableMemberCount,
          activeLifecycleSummary.billableMemberCount,
        );
        assert.equal(
          restoredLifecycleSummary.estimatedMonthlyMinor,
          activeLifecycleSummary.estimatedMonthlyMinor,
        );
        const organizationDetail = expect(
          await call(
            "GET",
            `/v1/platform/organizations/${organizationId}`,
            invited.cookie,
          ),
          200,
        );
        assert.ok(organizationDetail.memberships.length >= 4);
        assert.ok(organizationDetail.groups.length >= 1);
        assert.equal(organizationDetail.billingProfile.currency, "USD");
        expect(
          await call("GET", `/v1/organizations/${secondOrg}`, owner.cookie),
          404,
        );

        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/billing`,
            joiner.cookie,
          ),
          403,
        );
        const estimate = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/billing`,
            invited.cookie,
          ),
          200,
        );
        assert.equal(estimate.currency, "USD");
        assert.equal(estimate.basePriceMinor, 1400);
        assert.equal(estimate.memberPriceMinor, 500);
        assert.equal(estimate.billableMemberCount, 4);
        assert.equal(estimate.groupsCostMinor, 0);
        assert.equal(estimate.estimatedMonthlyMinor, 3400);
        const billingUpdated = expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/billing`,
            invited.cookie,
            { billingEmail: `BILLING-${prefix}@blackpolar.test` },
          ),
          200,
        );
        assert.equal(
          billingUpdated.billingEmail,
          `billing-${prefix}@blackpolar.test`,
        );
        assert.equal(
          expect(
            await call(
              "PATCH",
              `/v1/platform/organizations/${organizationId}/billing/status`,
              owner.cookie,
              { status: "PAST_DUE" },
            ),
            200,
          ).status,
          "PAST_DUE",
        );
        const billingSummary = expect(
          await call("GET", "/v1/platform/billing/summary", invited.cookie),
          200,
        );
        assert.equal(billingSummary.currency, "USD");
        assert.equal(billingSummary.basePriceMinor, 1400);
        assert.equal(billingSummary.memberPriceMinor, 500);
        assert.equal(billingSummary.groupsCostMinor, 0);
        assert.ok(billingSummary.organizationCount >= 3);
        assert.ok(billingSummary.billableMemberCount >= 6);
        assert.equal(billingSummary.byStatusScope, "ALL_PROFILES");

        const closedBilling = expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/billing/status`,
            owner.cookie,
            { status: "CLOSED" },
          ),
          200,
        );
        assert.equal(closedBilling.status, "CLOSED");
        assert.equal(closedBilling.basePriceMinor, 1400);
        assert.equal(closedBilling.memberPriceMinor, 500);
        assert.equal(closedBilling.billableMemberCount, 0);
        assert.equal(closedBilling.estimatedMonthlyMinor, 0);
        const closedSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(closedSummary.byStatusScope, "ALL_PROFILES");
        assert.equal(
          closedSummary.organizationCount,
          billingSummary.organizationCount - 1,
        );
        assert.equal(
          closedSummary.billableMemberCount,
          billingSummary.billableMemberCount - 4,
        );
        assert.equal(
          closedSummary.estimatedMonthlyMinor,
          billingSummary.estimatedMonthlyMinor - 3400,
        );
        assert.ok(
          closedSummary.byStatus.some(
            (entry: { status: string; count: number }) =>
              entry.status === "CLOSED" && entry.count >= 1,
          ),
        );

        const reopenedBilling = expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/billing/status`,
            owner.cookie,
            { status: "PAST_DUE" },
          ),
          200,
        );
        assert.equal(reopenedBilling.status, "PAST_DUE");
        assert.equal(reopenedBilling.billableMemberCount, 4);
        assert.equal(reopenedBilling.estimatedMonthlyMinor, 3400);
        const reopenedSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(
          reopenedSummary.organizationCount,
          billingSummary.organizationCount,
        );
        assert.equal(
          reopenedSummary.billableMemberCount,
          billingSummary.billableMemberCount,
        );
        assert.equal(
          reopenedSummary.estimatedMonthlyMinor,
          billingSummary.estimatedMonthlyMinor,
        );

        expect(
          await call(
            "PATCH",
            `/v1/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "ARCHIVED" },
          ),
          200,
        );
        const archivedBilling = expect(
          await call(
            "GET",
            `/v1/platform/organizations/${organizationId}/billing`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(archivedBilling.status, "PAST_DUE");
        assert.equal(archivedBilling.billableMemberCount, 0);
        assert.equal(archivedBilling.estimatedMonthlyMinor, 0);
        const archivedSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(
          archivedSummary.organizationCount,
          reopenedSummary.organizationCount - 1,
        );
        assert.equal(
          archivedSummary.billableMemberCount,
          reopenedSummary.billableMemberCount - 4,
        );
        assert.equal(
          archivedSummary.estimatedMonthlyMinor,
          reopenedSummary.estimatedMonthlyMinor - 3400,
        );
        expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/status`,
            owner.cookie,
            { status: "ACTIVE" },
          ),
          200,
        );
        const restoredArchivedBilling = expect(
          await call(
            "GET",
            `/v1/platform/organizations/${organizationId}/billing`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(restoredArchivedBilling.status, "PAST_DUE");
        assert.equal(restoredArchivedBilling.billableMemberCount, 4);
        assert.equal(restoredArchivedBilling.estimatedMonthlyMinor, 3400);
        const restoredArchivedSummary = expect(
          await call("GET", "/v1/platform/billing/summary", owner.cookie),
          200,
        );
        assert.equal(
          restoredArchivedSummary.organizationCount,
          reopenedSummary.organizationCount,
        );
        assert.equal(
          restoredArchivedSummary.billableMemberCount,
          reopenedSummary.billableMemberCount,
        );
        assert.equal(
          restoredArchivedSummary.estimatedMonthlyMinor,
          reopenedSummary.estimatedMonthlyMinor,
        );
        expect(
          await call(
            "PATCH",
            `/v1/platform/organizations/${organizationId}/billing/status`,
            invited.cookie,
            { status: "ACTIVE" },
          ),
          403,
        );
        await prisma.user.update({
          where: { id: owner.id },
          data: { role: "USER" },
        });
        await prisma.user.update({
          where: { id: invited.id },
          data: { role: "USER" },
        });
      },
    );
    await t.test(
      "audit append failure rolls back mutations and rows resist modification",
      async () => {
        const append = auditRepository.append;
        auditRepository.append = async () => {
          throw new Error("simulated unavailable audit");
        };
        try {
          expect(
            await call("POST", "/v1/organizations", owner.cookie, {
              name: "Rollback",
              slug: `${prefix}-rollback`,
            }),
            500,
          );
        } finally {
          auditRepository.append = append;
        }
        assert.equal(
          await prisma.organization.count({
            where: { slug: `${prefix}-rollback` },
          }),
          0,
        );
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: { organizationId },
        });
        await assert.rejects(
          prisma.auditLog.update({
            where: { id: audit.id },
            data: { action: "forged" },
          }),
        );
        await assert.rejects(
          prisma.auditLog.delete({ where: { id: audit.id } }),
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/audit`,
            invited.cookie,
          ),
          403,
        );
      },
    );
    await t.test(
      "API keys enforce scope, ownership, membership, and immediate revocation",
      async () => {
        const key = expect(
          await call("POST", "/v1/security/keys", owner.cookie, {
            name: "Read access",
            scopes: ["organizations:read"],
          }),
          201,
        );
        keyId = key.id;
        keyToken = key.token;
        assert.ok(!("keyHash" in key));
        const auth = { authorization: `Bearer ${keyToken}` };
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}`,
            undefined,
            undefined,
            auth,
          ),
          200,
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${secondOrg}`,
            undefined,
            undefined,
            auth,
          ),
          404,
        );
        expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/entitlements`,
            undefined,
            undefined,
            auth,
          ),
          403,
        );
        expect(
          await call(
            "POST",
            "/v1/organizations",
            undefined,
            { name: "Nope", slug: "nope" },
            auth,
          ),
          403,
        );
        expect(
          await call("DELETE", `/v1/security/keys/${keyId}`, outsider.cookie),
          404,
        );
        expect(
          await call("DELETE", `/v1/security/keys/${keyId}`, owner.cookie),
          200,
        );
        expect(
          await call("GET", "/v1/organizations", undefined, undefined, auth),
          401,
        );
      },
    );
    await t.test(
      "commerce requires operator authority and resolves explicit entitlements",
      async () => {
        expect(
          await call("POST", "/v1/commerce/products", owner.cookie, {
            code: `${prefix}-demo`,
            name: "Demo",
          }),
          403,
        );
        // Test fixture grants a global operator role through infrastructure, never client input.
        await prisma.user.update({
          where: { id: owner.id },
          data: { role: "SUPERADMIN" },
        });
        const product = expect(
          await call("POST", "/v1/commerce/products", owner.cookie, {
            code: `${prefix}-demo`,
            name: "Demo",
          }),
          201,
        );
        const plan = expect(
          await call("POST", "/v1/commerce/plans", owner.cookie, {
            productId: product.id,
            code: "annual",
            name: "Annual",
            priceMinor: 15000,
            currency: "USD",
            interval: "year",
            features: ["reports.read"],
          }),
          201,
        );
        const body = {
          organizationId,
          planId: plan.id,
          endsAt: new Date(Date.now() + 86400000).toISOString(),
        };
        const headers = { "idempotency-key": `${prefix}-contract-0001` };
        expect(
          await call("POST", "/v1/commerce/subscriptions", owner.cookie, body),
          400,
        );
        const subscription = expect(
          await call(
            "POST",
            "/v1/commerce/subscriptions",
            owner.cookie,
            body,
            headers,
          ),
          201,
        );
        subscriptionId = subscription.id;
        assert.ok(!("requestHash" in subscription));
        assert.equal(subscription.invoices[0].status, "open");
        assert.equal(
          expect(
            await call(
              "POST",
              "/v1/commerce/subscriptions",
              owner.cookie,
              body,
              headers,
            ),
            201,
          ).id,
          subscriptionId,
        );
        expect(
          await call(
            "POST",
            "/v1/commerce/subscriptions",
            owner.cookie,
            { ...body, organizationId: secondOrg },
            headers,
          ),
          409,
        );
        const entitlements = expect(
          await call(
            "GET",
            `/v1/organizations/${organizationId}/entitlements`,
            invited.cookie,
          ),
          200,
        );
        assert.equal(entitlements.length, 1);
        expect(
          await call(
            "POST",
            `/v1/commerce/organizations/${organizationId}/subscriptions/${subscriptionId}/cancel`,
            invited.cookie,
          ),
          403,
        );
        expect(
          await call(
            "POST",
            `/v1/commerce/organizations/${organizationId}/subscriptions/${subscriptionId}/cancel`,
            owner.cookie,
          ),
          200,
        );
        assert.equal(
          expect(
            await call(
              "GET",
              `/v1/organizations/${organizationId}/entitlements`,
              invited.cookie,
            ),
            200,
          ).length,
          0,
        );
        // Global administrator still cannot read unrelated tenants.
        expect(
          await call("GET", `/v1/organizations/${secondOrg}`, owner.cookie),
          404,
        );
      },
    );
    await t.test(
      "contact saves only validated consent and enforces origin",
      async () => {
        const data = {
          name: "Test Person",
          email: "test@blackpolar.test",
          organization: "Example",
          country: "Colombia",
          project: "Web",
          message: "A test request",
          locale: "en-us",
          consent: true,
        };
        expect(
          await call("POST", "/v1/contact", undefined, {
            ...data,
            consent: false,
          }),
          400,
        );
        const saved = expect(
          await call("POST", "/v1/contact", undefined, data),
          201,
        );
        assert.equal(
          (
            await prisma.contactRequest.findUniqueOrThrow({
              where: { id: saved.id },
            })
          ).notificationStatus,
          "pending",
        );
        const { processOneContactNotification } = await import(
          "../src/modules/business/contact-notifications.js"
        );
        assert.equal(await processOneContactNotification(), true);
        const notified = await prisma.contactRequest.findUniqueOrThrow({
          where: { id: saved.id },
        });
        assert.equal(notified.notificationStatus, "sent");
        assert.equal(notified.notificationAttempts, 1);
        assert.ok(notified.notificationSentAt);
        assert.match(messages.at(-1)!, /New Black Polar contact request/);
        assert.match(messages.at(-1)!, /Test Person/);
        expect(
          await call("POST", "/v1/contact", undefined, data, {
            origin: "https://evil.test",
          }),
          403,
        );
        const csrf = await app.inject({
          method: "PATCH",
          url: `/v1/users/${owner.id}`,
          headers: { cookie: owner.cookie },
          payload: { name: "Changed" },
        });
        expect(csrf, 403);
      },
    );
    await t.test("sign-out revokes the real Better Auth session", async () => {
      expect(await call("POST", "/v1/auth/sign-out", outsider.cookie, {}), 200);
      expect(await call("GET", "/v1/me", outsider.cookie), 401);
    });
    await t.test(
      "missing SMTP fails closed before creating an account",
      async () => {
        const smtpUrl = process.env.SMTP_URL;
        delete process.env.SMTP_URL;
        try {
          expect(
            await call("POST", "/v1/auth/sign-up/email", undefined, {
              email: `${prefix}-blocked@blackpolar.test`,
              name: "Blocked",
              password,
            }),
            503,
          );
          assert.equal(
            await prisma.user.count({
              where: { email: `${prefix}-blocked@blackpolar.test` },
            }),
            0,
          );
        } finally {
          process.env.SMTP_URL = smtpUrl;
        }
      },
    );
    await t.test("operator recovery creates and replaces a temporary credential", async () => {
      await prisma.user.update({ where: { id: owner.id }, data: { role: "USER" } });
      const recoveryEmail = `${prefix}-operator-recovery@blackpolar.test`;
      const recoveryUser = await prisma.user.create({
        data: {
          email: recoveryEmail,
          name: "Recovered operator",
          emailVerified: true,
        },
      });
      await prisma.session.create({
        data: {
          userId: recoveryUser.id,
          token: `stale_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const { bootstrapOperator } = await import(
        "../src/modules/identity/bootstrap.js"
      );
      const firstTemporaryPassword = "First-temporary-password-123!";
      const secondTemporaryPassword = "Second-temporary-password-456!";
      await bootstrapOperator(
        recoveryEmail,
        "First-permanent-admin-secret-123!",
        firstTemporaryPassword,
      );
      await bootstrapOperator(
        recoveryEmail,
        "Second-permanent-admin-secret-456!",
        secondTemporaryPassword,
      );

      const configured = await prisma.user.findUniqueOrThrow({
        where: { id: recoveryUser.id },
        include: { accounts: { where: { providerId: "credential" } } },
      });
      assert.equal(configured.role, "SUPERADMIN");
      assert.equal(configured.passwordChangeRequired, true);
      assert.equal(configured.accounts.length, 1);
      assert.ok(configured.accounts[0]!.password);
      assert.equal(
        await verifyPassword({
          hash: configured.accounts[0]!.password!,
          password: firstTemporaryPassword,
        }),
        false,
      );
      assert.equal(
        await verifyPassword({
          hash: configured.accounts[0]!.password!,
          password: secondTemporaryPassword,
        }),
        true,
      );
      assert.equal(await prisma.session.count({ where: { userId: recoveryUser.id } }), 0);

      // Isolate this flow from the shared-IP Better Auth limiter exercised by
      // the many preceding auth scenarios in this single integration process.
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/sign-in/email",
        remoteAddress: "127.0.0.2",
        headers: { origin: "http://localhost:3000" },
        payload: {
          email: recoveryEmail,
          password: secondTemporaryPassword,
        },
      });
      expect(login, 200);
      const recoveryCookie = cookieOf(login);
      assert.match(
        recoveryCookie,
        /better-auth\.session_token=/,
        "Recovery sign-in must set the Better Auth session cookie",
      );
      const issuedSession = await prisma.session.findFirst({
        where: { userId: recoveryUser.id },
        orderBy: { createdAt: "desc" },
      });
      assert.ok(issuedSession, "Recovery sign-in must persist a session");
      const temporaryMe = expect(await call("GET", "/v1/me", recoveryCookie), 200);
      assert.equal(temporaryMe.passwordChangeRequired, true);
      expect(
        await call("POST", "/v1/me/terms", recoveryCookie, {
          version: "2026-09-16",
        }),
        403,
      );
      expect(
        await call("POST", "/v1/me/change-temporary-password", recoveryCookie, {
          currentPassword: "Wrong-temporary-password-789!",
          newPassword: "Final-operator-password-789!",
        }),
        401,
      );
      const otherSession = await prisma.session.create({
        data: {
          userId: recoveryUser.id,
          token: `other_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const changed = expect(
        await call("POST", "/v1/me/change-temporary-password", recoveryCookie, {
          currentPassword: secondTemporaryPassword,
          newPassword: "Final-operator-password-789!",
        }),
        200,
      );
      assert.equal(changed.passwordChangeRequired, false);
      assert.equal(
        await prisma.session.count({ where: { id: otherSession.id } }),
        0,
      );
      expect(await call("GET", "/v1/me", recoveryCookie), 200);
      const updatedCredential = await prisma.account.findFirstOrThrow({
        where: { userId: recoveryUser.id, providerId: "credential" },
      });
      assert.ok(updatedCredential.password);
      assert.equal(
        await verifyPassword({
          hash: updatedCredential.password!,
          password: "Final-operator-password-789!",
        }),
        true,
      );
      assert.ok(await prisma.auditLog.findFirst({
        where: {
          actorId: recoveryUser.id,
          action: "identity.credential.temporary.complete",
        },
      }));
      expect(
        await call("POST", "/v1/me/change-temporary-password", recoveryCookie, {
          currentPassword: "Final-operator-password-789!",
          newPassword: "Another-final-password-321!",
        }),
        409,
      );
    });
    await t.test("platform audit and summary contracts are additive and role-scoped", async () => {
      const auditor = await signup("platform-superadmin");
      const delegate = await signup("platform-admin");
      const plain = await signup("platform-user");
      await prisma.user.update({ where: { id: auditor.id }, data: { role: "SUPERADMIN" } });
      await prisma.user.update({ where: { id: delegate.id }, data: { role: "ADMIN" } });

      // Authorization: the global audit trail is superadmin-only and fails closed.
      expect(await call("GET", "/v1/platform/audit"), 401);
      expect(await call("GET", "/v1/platform/audit", plain.cookie), 403);
      expect(await call("GET", "/v1/platform/audit", delegate.cookie), 403);
      expect(await call("GET", "/v1/platform/audit?limit=0", auditor.cookie), 400);
      expect(await call("GET", "/v1/platform/audit?limit=101", auditor.cookie), 400);
      expect(await call("GET", "/v1/platform/audit?from=not-a-date", auditor.cookie), 400);
      expect(await call("GET", "/v1/platform/audit?unknown=1", auditor.cookie), 400);

      const first = expect(await call("GET", "/v1/platform/audit?limit=2", auditor.cookie), 200);
      assert.equal("logs" in first, false, "the envelope is items + nextCursor");
      assert.ok(Array.isArray(first.items));
      assert.ok(first.items.length > 0 && first.items.length <= 2);
      assert.ok("nextCursor" in first);
      for (const field of ["id", "actorId", "organizationId", "action", "targetType", "targetId", "requestId", "metadata", "createdAt"]) {
        assert.ok(field in first.items[0], `audit event exposes ${field}`);
      }

      // Filters are enforced server-side.
      const byAction = expect(await call("GET", "/v1/platform/audit?action=logs.view&limit=5", auditor.cookie), 200);
      assert.ok(byAction.items.every((item: { action: string }) => item.action === "logs.view"));
      const byActor = expect(await call("GET", `/v1/platform/audit?actorId=${auditor.id}&limit=5`, auditor.cookie), 200);
      assert.ok(byActor.items.length > 0, "the audited read itself is recorded");
      assert.ok(byActor.items.every((item: { actorId: string | null }) => item.actorId === auditor.id));
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const windowed = expect(await call("GET", `/v1/platform/audit?from=${encodeURIComponent(since)}&limit=5`, auditor.cookie), 200);
      assert.ok(windowed.items.every((item: { createdAt: string }) => Date.parse(item.createdAt) >= Date.now() - 3_600_000 - 60_000));

      // Cursor pagination resumes after the cursor without repeating rows.
      const pageOne = expect(await call("GET", "/v1/platform/audit?limit=2", auditor.cookie), 200);
      assert.ok(pageOne.nextCursor);
      const pageTwo = expect(await call("GET", `/v1/platform/audit?limit=2&cursor=${pageOne.nextCursor}`, auditor.cookie), 200);
      const seen = new Set(pageOne.items.map((item: { id: string }) => item.id));
      assert.ok(pageTwo.items.length > 0);
      assert.ok(pageTwo.items.every((item: { id: string }) => !seen.has(item.id)));

      // The same identity flips from 403 to 200 only when its global role changes.
      await prisma.user.update({ where: { id: delegate.id }, data: { role: "SUPERADMIN" } });
      expect(await call("GET", "/v1/platform/audit?limit=1", delegate.cookie), 200);

      // Tenant-scoped audit remains member-driven and organization-bound.
      const tenantAudit = expect(await call("GET", `/v1/organizations/${organizationId}/audit?limit=5`, owner.cookie), 200);
      assert.ok(Array.isArray(tenantAudit));
      assert.ok(tenantAudit.every((item: { organizationId: string }) => item.organizationId === organizationId));
      // Summary: operators read it, ordinary identities do not.
      expect(await call("GET", "/v1/platform/summary"), 401);
      expect(await call("GET", "/v1/platform/summary", plain.cookie), 403);
      const adminSummary = expect(await call("GET", "/v1/platform/summary", delegate.cookie), 200);
      const rootSummary = expect(await call("GET", "/v1/platform/summary", auditor.cookie), 200);
      assert.ok(adminSummary.users.total >= 3);
      assert.ok(rootSummary.organizations.total >= 1);
      assert.ok(Number.isInteger(rootSummary.users.createdLast7Days));
      assert.ok(Number.isInteger(rootSummary.users.createdLast30Days));
      assert.ok(Number.isInteger(rootSummary.organizations.createdLast30Days));
      assert.ok(Number.isInteger(rootSummary.memberships.total));
      assert.ok(Number.isInteger(rootSummary.sessions.active));
      assert.ok(Number.isInteger(rootSummary.users.active) && Number.isInteger(rootSummary.users.suspended));
      assert.ok(rootSummary.users.active + rootSummary.users.suspended === rootSummary.users.total);

      // BigInt byte counters must cross the contract as decimal strings.
      for (const key of ["usedBytes", "limitBytes", "reservedBytes"]) {
        assert.equal(typeof rootSummary.storage[key], "string", `${key} is a string`);
        assert.match(rootSummary.storage[key], /^\d+$/);
      }
      assert.equal(rootSummary.billing.currency, "USD");
      assert.equal(rootSummary.billing.basePriceMinor, 1400);
      assert.equal(rootSummary.billing.memberPriceMinor, 500);
      assert.ok(!Number.isNaN(Date.parse(rootSummary.generatedAt)));

      // The dashboard must agree with the billing surface whose formula it reuses.
      const billingSummary = expect(await call("GET", "/v1/platform/billing/summary", auditor.cookie), 200);
      assert.equal(rootSummary.billing.estimatedMonthlyMinor, billingSummary.estimatedMonthlyMinor);
      assert.equal(rootSummary.billing.billableMemberCount, billingSummary.billableMemberCount);
      assert.equal(rootSummary.billing.billableOrganizationCount, billingSummary.organizationCount);

      // The organization list exposes the accountable owner additively.
      const organizations = expect(await call("GET", "/v1/platform/organizations?limit=100", auditor.cookie), 200);
      const listed = organizations.items.find((item: { id: string }) => item.id === organizationId);
      assert.ok(listed, "the platform list includes the tenant");
      assert.ok("owner" in listed);
      assert.equal(typeof listed.memberCount, "number");
      assert.equal(typeof listed.groupCount, "number");
      assert.ok("createdAt" in listed, "older fields are preserved");
      const oldestOwner = await prisma.membership.findFirst({
        where: { organizationId, role: "OWNER" },
        orderBy: { createdAt: "asc" },
        select: { user: { select: { id: true, email: true } } },
      });
      assert.equal(listed.owner?.id ?? null, oldestOwner?.user.id ?? null);
      if (listed.owner) assert.match(listed.owner.email, /@/);
    });
    await t.test("NORTH global templates, authorized search, and request-correlated audit are isolated", async () => {
      const layout = {
        desktop: { x: 0, y: 0, w: 12, h: 1 },
        tablet: { x: 0, y: 0, w: 12, h: 1 },
        mobile: { x: 0, y: 0, w: 12, h: 1 },
      };
      const snapshot = {
        schemaVersion: 1,
        category: { name: { en: "Operations" }, slug: "operations" },
        subcategories: [{
          name: { en: "Reports" }, slug: "reports", panels: [{
            name: { en: "Weekly overview" }, description: { en: "Template search needle" }, slug: "weekly-overview",
            audience: { type: "ALL_MEMBERS", roles: [], capabilities: [] },
            document: {
              schemaVersion: 1, defaultLocale: "en", fallbackLocales: [],
              sections: [{ id: "template-section", order: 0, layout: { variant: "grid", gap: "md" }, components: [{
                id: "template-heading", type: "heading", schemaVersion: 1,
                props: { text: { en: "Template search needle" }, level: 1 }, bindings: {}, layout, order: 0,
              }] }],
            },
          }],
        }],
      };
      expect(await call("POST", "/v1/platform/north/templates", invited.cookie, {
        name: { en: "Denied" }, slug: `denied-${prefix}`, snapshot,
      }), 403);
      await prisma.user.update({ where: { id: owner.id }, data: { role: "SUPERADMIN" } });
      const created = expect(await call("POST", "/v1/platform/north/templates", owner.cookie, {
        name: { en: "Operations template" }, slug: `operations-${prefix}`, snapshot,
      }), 201);
      assert.equal(created.currentVersion, 1);
      const listed = expect(await call("GET", `/v1/organizations/${organizationId}/north/templates`, owner.cookie), 200);
      assert.ok(listed.some((item: { id: string }) => item.id === created.id));
      const applied = expect(await call("POST", `/v1/organizations/${organizationId}/north/templates/${created.id}/apply`, owner.cookie, {
        slug: `operations-copy-${prefix}`,
      }), 201);
      assert.equal(applied.sourceTemplateId, created.id);
      assert.equal(applied.sourceTemplateVersion, 1);
      const copiedPanel = await prisma.northPanel.findFirstOrThrow({
        where: { subcategory: { categoryId: applied.id } },
        include: { draftRevision: true },
      });
      assert.equal(copiedPanel.status, "DRAFT");
      assert.ok(copiedPanel.draftRevision);
      const copiedDocument = copiedPanel.draftRevision!.document as typeof snapshot.subcategories[0]["panels"][0]["document"];
      assert.notEqual(copiedDocument.sections[0]!.id, "template-section");
      assert.notEqual(copiedDocument.sections[0]!.components[0]!.id, "template-heading");

      const draftSearch = expect(await call("GET", `/v1/organizations/${organizationId}/north/search?query=Template%20search%20needle&resourceType=PANEL&status=DRAFT`, owner.cookie), 200);
      assert.ok(draftSearch.some((item: { id: string }) => item.id === copiedPanel.id));
      const hiddenDraftSearch = await call("GET", `/v1/organizations/${organizationId}/north/search?query=Template%20search%20needle&resourceType=PANEL&status=DRAFT`, invited.cookie);
      assert.equal(hiddenDraftSearch.statusCode, 200);
      assert.equal(hiddenDraftSearch.json().length, 0);
      expect(await call("GET", `/v1/organizations/${secondOrg}/north/search?query=Template`, joiner.cookie), 404);

      const changed = structuredClone(snapshot);
      changed.subcategories[0]!.panels[0]!.name.en = "Changed global template";
      const secondVersion = expect(await call("POST", `/v1/platform/north/templates/${created.id}/versions`, owner.cookie, { snapshot: changed }), 201);
      await assert.rejects(prisma.northTemplateVersion.update({ where: { id: secondVersion.id }, data: { version: 3 } }));
      await assert.rejects(prisma.northTemplateVersion.delete({ where: { id: secondVersion.id } }));
      assert.equal((await prisma.northCategory.findUniqueOrThrow({ where: { id: applied.id } })).sourceTemplateVersion, 1);
      assert.deepEqual((await prisma.northPanel.findUniqueOrThrow({ where: { id: copiedPanel.id } })).name, copiedPanel.name);

      const malicious = structuredClone(snapshot);
      malicious.subcategories[0]!.panels[0]!.document.sections[0]!.components[0]!.props.text.en = "<script>alert(1)</script>";
      const rejected = await call("POST", "/v1/platform/north/templates", owner.cookie, {
        name: { en: "Rejected" }, slug: `rejected-${prefix}`, snapshot: malicious,
      });
      assert.equal(rejected.statusCode, 422);
      assert.equal(rejected.json().error.code, "CONTENT_EXECUTABLE_NOT_ALLOWED");

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "TEMPLATE_APPLIED", targetId: applied.id },
      });
      assert.ok(audit.requestId);
    });
    await t.test("admin-secret sign-in is hashed, generic, and cookie-only", async () => {
      const adminEmail = `${prefix}-admin-secret@blackpolar.test`;
      const adminSecret = "Integration-admin-secret-789!";
      const admin = await prisma.user.create({
        data: {
          email: adminEmail,
          name: "Admin secret test",
          emailVerified: true,
          role: "ADMIN",
          adminSecretHash: await hashPassword(adminSecret),
        },
      });
      const wrong = await call("POST", "/v1/admin/sign-in", undefined, {
        email: adminEmail,
        secret: "Incorrect-admin-secret-789!",
      });
      const unknown = await call("POST", "/v1/admin/sign-in", undefined, {
        email: `${prefix}-missing@blackpolar.test`,
        secret: "Incorrect-admin-secret-789!",
      });
      assert.equal(wrong.statusCode, 401);
      assert.equal(unknown.statusCode, 401);
      assert.equal(wrong.json().error.message, unknown.json().error.message);

      const login = await call("POST", "/v1/admin/sign-in", undefined, {
        email: adminEmail,
        secret: adminSecret,
      });
      const body = expect(login, 200);
      assert.equal(body.user.id, admin.id);
      assert.equal("token" in body, false);
      assert.equal("adminSecretHash" in body.user, false);
      const cookie = cookieOf(login);
      assert.match(cookie, /better-auth\.session_token=/);
      assert.equal(expect(await call("GET", "/v1/me", cookie), 200).id, admin.id);
      assert.ok(await prisma.auditLog.findFirst({
        where: { actorId: admin.id, action: "identity.admin-secret.signin" },
      }));
      expect(await call("POST", "/v1/identity/legacy-migration", cookie, {
        email: adminEmail,
        password,
      }), 404);
    });
  },
);
