# CoreCrow API priorities

This list extends the accepted architecture without pretending the routes already exist. New public routes remain versioned under `/v1`, schema-first, tenant-aware, default-deny, audited where sensitive, and backed exclusively by CoreCrow persistence.

## P0 — close current operational gaps

1. **Implemented:** `GET /v1/status/summary?window=1h|6h|24h` — sanitized aggregate request rate, latency percentiles, 4xx/5xx counts, process uptime and five-minute time-series buckets for the public status page. It never exposes tenant identifiers, raw paths, IPs, request bodies or secrets. Coverage begins at process start; persistent external availability remains future observability work.
2. `GET /v1/organizations/:organizationId/invitations` — list pending invitations for authorized owners/admins, with pagination and without invitation tokens.
3. `PATCH /v1/contact/:id` — operator-only contact triage state (`new`, `in_progress`, `closed`) with an audit event. Keep private notes out of the public submission response.
4. Consistent cursor pagination and filtering for users, members, invitations, audit events and contact requests before their datasets grow.

## P1 — NORTH workspace vertical slice

1. `GET|POST /v1/organizations/:organizationId/workspaces`
2. `GET|PATCH /v1/workspaces/:workspaceId`
3. `GET|PUT /v1/workspaces/:workspaceId/draft` using optimistic concurrency (`If-Match` or an explicit version).
4. `POST /v1/workspaces/:workspaceId/validate`
5. `POST /v1/workspaces/:workspaceId/publish` with idempotency and an immutable revision.
6. `GET /v1/workspaces/:workspaceId/revisions`
7. `GET /v1/workspaces/:workspaceId/revisions/:revisionId`

Workspace configuration must be declarative and validated against registered component schemas. It cannot contain executable code, database credentials or arbitrary SQL. Every route resolves organization ownership from authoritative membership rather than trusting a client-supplied tenant context.

## P2 — later, after explicit provider decisions

- Controlled file upload/download contracts after choosing a storage provider.
- Provider webhooks with signature verification, replay protection and idempotent processing.
- Payment and recurring billing routes only after the provider and licensing model have accepted decisions.
- Declarative data-source bindings whose credentials remain inside CoreCrow infrastructure.

## Cross-cutting acceptance criteria

Every route needs request/response schemas, stable machine-readable errors, OpenAPI generation, positive and negative authorization tests, cross-tenant isolation tests, bounded pagination, safe logging, rate limits proportional to abuse risk, migration and compatibility analysis, and audit coverage for security-sensitive or commercial state changes.
