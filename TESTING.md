# Testing CoreCrow

Current executable commands and isolation rules are documented in [README](README.md#verification). The test suite uses Node's test runner through tsx; no Vitest dependency is implied.

`pnpm test:unit` covers default-deny permissions, role management and degraded health.
`TEST_DATABASE_URL=... pnpm test` additionally runs the PostgreSQL integration suite using a loopback SMTP sink. Windows PowerShell: set `$env:TEST_DATABASE_URL` before running the command. Only local databases ending in `_test` are accepted. Migrate the isolated database first; tests do not reset or delete existing databases.

Coverage includes actual signup/email verification/login/logout, untrusted global roles, tenant isolation, owner protection, invitation replay/revocation/expiry, transactional audit rollback, immutable logs, key scopes and revocation, contract idempotency, entitlement cancellation, contact consent and origin checks. See `tests/integration.test.ts` for exact assertions.

A passing local suite does not certify production configuration, real SMTP delivery, Google OAuth, provider payment integration, Docker/nginx or a deployed release. CI uses PostgreSQL 16 and runs verification before deployment.
