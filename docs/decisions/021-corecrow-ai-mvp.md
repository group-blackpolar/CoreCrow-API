# CoreCrow AI MVP with Gemini 2.5 Flash

- Status: Accepted implementation record
- Date: 2026-10-07
- Scope: CORECROW

## Decision

CoreCrow AI begins as a module of the CORECROW modular monolith. The application layer owns conversations, asynchronous PostgreSQL-backed runs, tool orchestration, confirmation records, usage estimates and audit transitions. Provider details remain behind `AIProvider`; Gemini 2.5 Flash is the first configured implementation. Provider credentials never cross the backend boundary.

The v1 AI contract is additive. Run creation returns `202` and a run identifier. Authenticated SSE reads persisted events and supports terminal replay. The process-local dispatcher claims queued database rows; this is intentionally not a durable multi-process scheduler and must be replaced or extended before horizontal workers are introduced.

Provider output and retained prompt context have explicit configurable ceilings. On restart, interrupted rows are returned to the queue and drained sequentially; this deliberately favors respecting concurrency limits over recovery throughput until a durable worker scheduler exists.

All MVP conversations are organization-scoped and use the `north` application allowlist. AI tenant authorization resolves the active organization and authoritative membership before permissions. It never consults global roles or NORTH platform grants. This deliberately isolates AI from the existing NORTH platform bypass in `modules/north/authorization.ts`; changing those existing NORTH semantics requires a separate compatibility decision and migration.

The initial tool registry is explicit and read-only. Tools call existing CORECROW services, validate arguments, filter exposure by application and effective tenant permission, then reauthorize at execution. Mutation and critical tools are not registered. Confirmation storage and endpoints are additive infrastructure only and cannot make an unregistered mutation executable.

AI background execution emits structured, prompt-free logs carrying `runId`, tenant/actor identifiers, provider/model, tool-call identifiers, stable error codes, usage and latency as applicable. HTTP request correlation remains in the existing request logger and audit request context; AI audit transitions inherit the request identifier when execution remains in that context. Logs never include prompts, tool arguments/results, provider responses, credentials or secrets.

## Compatibility and limitations

Existing routes and NORTH behavior are unchanged. The migration only adds AI tables and enums. AI is disabled by default, so `/v1/ai/*` fails closed without contacting a provider. API keys remain unsupported for AI routes. Desktop clients must consume SSE with authenticated `fetch` streaming because browser `EventSource` cannot attach a bearer header.

Gemini model access can vary by Google project. Provider authentication, missing-model, rate-limit, timeout and unavailable failures are normalized and do not expose raw provider errors. RAG, embeddings, Redis, local inference, multi-agent orchestration, service principals, advanced billing and mutation tools remain out of scope.

Unit coverage exercises provider normalization/failures/timeouts, fail-closed feature flags, platform-bypass and cross-tenant membership rejection, permission-filtered and invalid tools, action state/re-authorization helpers, JSON-safe usage projection, and self-profile minimization. Full persisted run lifecycle, provider/tool failure transitions, action confirm/cancel persistence, SSE replay across requests, and wrong-organization repository filtering require the isolated PostgreSQL integration suite. They must run only with a loopback `TEST_DATABASE_URL` whose database name ends in `_test`; an unavailable safe database is reported rather than substituted with a developer or production database.
