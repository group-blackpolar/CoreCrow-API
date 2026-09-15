import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";

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
    const app = await buildApp({ logger: false });
    await app.ready();
    t.after(async () => {
      await app.close();
      await prisma.$disconnect();
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    });
    const prefix = randomUUID().slice(0, 8);
    const password = "Test-password-only-123!";
    const call = (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      url: string,
      cookie?: string,
      payload?: unknown,
      extra = {},
    ) =>
      app.inject({
        method,
        url,
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
    async function signup(label: string) {
      const email = `${prefix}-${label}@blackpolar.test`;
      const response = await call("POST", "/v1/auth/sign-up/email", undefined, {
        email,
        password,
        name: label,
        role: "SUPERADMIN",
      });
      expect(response, 200);
      const record = await prisma.user.findUniqueOrThrow({ where: { email } });
      assert.equal(record.role, "USER");
      const rawMail = messages
        .at(-1)!
        .replace(/=\r?\n/g, "")
        .replace(/=3D/g, "=");
      const url = rawMail.match(
        /http:\/\/localhost:4000\/v1\/auth\/verify-email\?[^\s]+/,
      )?.[0];
      assert.ok(url, "Verification email includes the v1 URL");
      const verified = await app.inject({
        method: "GET",
        url: new URL(url).pathname + new URL(url).search,
      });
      assert.ok([200, 302].includes(verified.statusCode), verified.body);
      const login = await call("POST", "/v1/auth/sign-in/email", undefined, {
        email,
        password,
      });
      expect(login, 200);
      return { id: record.id, email, cookie: cookieOf(login) };
    }
    const owner = await signup("owner");
    const outsider = await signup("outsider");
    const invited = await signup("invited");
    let organizationId = "";
    let secondOrg = "";
    let invitationToken = "";
    let subscriptionId = "";
    let keyId = "";
    let keyToken = "";
    await t.test("session authority and public status", async () => {
      expect(await call("GET", "/v1/me"), 401);
      assert.equal(
        expect(await call("GET", "/v1/me", owner.cookie), 200).role,
        "USER",
      );
      expect(await call("GET", "/api/admin/exists"), 410);
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
        invitationToken = expect(
          await call(
            "POST",
            `/v1/organizations/${organizationId}/invitations`,
            owner.cookie,
            { email: invited.email, role: "MEMBER" },
          ),
          201,
        ).token;
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
            token: invite.token,
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
        await prisma.invitation.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(0) },
        });
        expect(
          await call("POST", "/v1/invitations/accept", outsider.cookie, {
            token: expired.token,
          }),
          404,
        );
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
    await t.test(
      "opt-in legacy enrollment retires the ID and old sessions permanently",
      async () => {
        process.env.ENABLE_LEGACY_ADMIN_AUTH = "true";
        const legacyApp = await buildApp({ logger: false });
        await legacyApp.ready();
        try {
          const legacyEmail = `${prefix}-legacy@blackpolar.test`;
          const legacyId = `legacy-test-${prefix}`;
          await prisma.user.create({
            data: {
              email: legacyEmail,
              name: "Legacy test",
              emailVerified: true,
              role: "ADMIN",
              adminUniqueId: legacyId,
            },
          });
          const login = await legacyApp.inject({
            method: "POST",
            url: "/api/admin/login",
            payload: { email: legacyEmail, adminUniqueId: legacyId },
          });
          assert.equal(login.statusCode, 200, login.body);
          const token = login.json().session.token;
          const migration = await legacyApp.inject({
            method: "POST",
            url: "/v1/identity/legacy-migration",
            headers: { authorization: `Bearer ${token}` },
            payload: { email: legacyEmail, password },
          });
          assert.equal(migration.statusCode, 200, migration.body);
          const old = await legacyApp.inject({
            method: "POST",
            url: "/api/admin/login",
            payload: { email: legacyEmail, adminUniqueId: legacyId },
          });
          assert.equal(old.statusCode, 401);
          const oldSession = await legacyApp.inject({
            method: "GET",
            url: "/api/users",
            headers: { authorization: `Bearer ${token}` },
          });
          assert.equal(oldSession.statusCode, 401);
          const modern = await legacyApp.inject({
            method: "POST",
            url: "/v1/auth/sign-in/email",
            remoteAddress: "127.0.0.2",
            headers: { origin: "http://localhost:3000" },
            payload: { email: legacyEmail, password },
          });
          expect(modern, 200);
        } finally {
          await legacyApp.close();
          delete process.env.ENABLE_LEGACY_ADMIN_AUTH;
        }
      },
    );
  },
);
