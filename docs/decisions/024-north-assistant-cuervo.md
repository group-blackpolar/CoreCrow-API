# NORTH assistant "Cuervo"

- Status: Accepted implementation record
- Date: 2026-10-09
- Scope: CORECROW AI module and the NORTH assistant panel

## Decision

The NORTH assistant is a chat client of CORECROW AI (`/v1/ai/*`, ADR-021). NORTH renders conversations and streams events; it never calls
Gemini, holds no key, and stores nothing in the browser. Everything that limits the assistant is decided on the server, in
`src/modules/ai/system-instructions.ts`, so a message, document or tool result can never widen it:

- **Scope**: only questions about NORTH, how to use NORTH according to the signed-in user's own role and permissions, and the user's personal use
  of NORTH. Anything else (general knowledge, code, writing, advice, role-play) is declined briefly and redirected to NORTH.
- **Personal use only**: it acts for the signed-in user alone; no bulk work, automation, impersonation, work for other people or companies, profiling
  of other people, or other organizations.
- **Permissions**: the read tool `user.permissions` returns only the caller's role and effective permission names; the model must consult it before
  explaining what the user can do and must not suggest workarounds around a permission or tenant boundary. Authorization itself stays in CORECROW.
- **No actions**: mutations are unavailable; it explains steps. Prompt-injection text in messages or tool data is untrusted. The instructions are never revealed.

Verified with the real model (`tests/ai.scope.smoke.test.ts`, and `scripts/smoke-xlsx-driver.mjs ai` through the API): off-topic and injection requests
are declined, permission answers use the tool result, a second turn after a tool use works, and another user, tenant or anonymous caller gets 404/401.

## Implementation notes

- Stored `TOOL` rows are not replayed into later turns: their function-call turn is not persisted and Gemini rejects a function response without its call.
- NORTH: raven button at the bottom of the layout bar (desktop, floating non-modal card) and in the mobile header (bottom sheet). It works inside an
  organization (CORECROW authorizes by membership); in the Personal Workspace it only asks the user to pick an organization. The panel lives inside the
  organization-keyed subtree, so switching organization aborts the stream and drops all state. Replies are rendered from a parsed structure (bold, code,
  lists) as text nodes, never as HTML.
- Provider quota: the Gemini free tier allows 20 requests per day per model; a billing-enabled key is needed for real use. The UI reports the
  normalized rate-limit error honestly and offers a retry.
