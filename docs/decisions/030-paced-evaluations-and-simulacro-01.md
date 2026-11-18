# 030 — Paced (forward-only) evaluations and the "Lectura Crítica — El principito | Simulacro 01" import

Status: implemented and tested (2026-11-18). Builds on ADR 029. No exam content lives in code: the simulacro is **data** imported through the API.

## 1. Gap analysis (what the engine lacked for this exam)
| Requirement | Engine before | Done |
| --- | --- | --- |
| 120 s per question, measured from the moment the **server** opens it | none (only a global deadline) | `settings.pacing { navigation, questionSeconds }`, `paced.ts` state machine |
| Sequential order, no going back after confirming | free navigation | `FORWARD_ONLY`: one open question at a time; closed questions can never change |
| Answer counts only when the backend accepts it ("Confirmar y continuar") | autosave of a selection was the answer | `POST …/evaluation-attempts/:id/confirm`; the autosaved selection is only a draft |
| `invalid_timeout` distinct from `omitted` | unanswered only | statuses `correct / incorrect / omitted / invalid_timeout`; `timedOut` in results, breakdowns and statistics |
| Global 30 min, finishes after the 15th question | global deadline | `durationMinutes: 30` + automatic end when every question is closed |
| Score by session and overall | per section already | `breakdown.bySection` (stored) + percent = correct / 15 x 100 |
| Idempotent, non-overwriting import | none | `Evaluation.key` (unique per organization) + `scripts/import-evaluation.mjs` |
| Rules/intro/description, 3 sessions of 5, responsive reader | partial | intro dialog from data, sections as sessions, chapter sheet on small screens |

## 2. Time rules (all decided on the server, from timestamps)
- Question *i* opens at the instant question *i-1* closed (confirmation time, or its own deadline when it timed out): unused time is never carried over, and an early confirmation gives the next question a full window of its own.
- A question closes by timeout at `openedAt + questionSeconds`, capped by the attempt's global deadline (`startedAt + durationMinutes`).
- A confirmation arriving **exactly** at the limit is valid; **one millisecond later** it is `invalid_timeout` (strict `>`). There is no grace period in paced mode (the free mode keeps its 10 s network allowance).
- Closing is *lazy and deterministic*: every entry point (`GET attempt`, `PUT answers`, `POST confirm`, `POST attempts`) first applies all timeouts whose deadline passed, each closed **at its own deadline**. Reloading, switching tabs or asking much later recovers no time (tested).
- Questions never reached before the global deadline are `invalid_timeout`. If the sum of the windows equals the total (15 x 120 s = 30 min) the global limit never binds; with a shorter total it does (tested with a 5-minute variant).
- The interface only *asks*: it draws clocks from the server's deadline and clock offset and shows what the server answered (`accepted: false` with `TIMEOUT / ALREADY_CLOSED / NOT_CURRENT`).

## 3. Confirmation endpoint
`POST /organizations/:org/evaluation-attempts/:attemptId/confirm  { questionId, optionId | null }` -> `{ accepted, reason, attempt }`.
`optionId: null` closes the question as `omitted`. Domain refusals are HTTP 200 with `accepted: false` so the state the server just decided (a timeout) is persisted, not rolled back. A repeated request with the same choice is idempotent (`accepted: true`); a different choice on a closed question is refused.
Concurrency: Serializable transactions + the `(attemptId, questionId)` primary key; two simultaneous different confirmations settle on exactly one. Paced attempts cannot be submitted early (`409 ATTEMPT_PACED`); they end after the last confirmation or at the limit.
Only the open question and its reference text are delivered; later questions are revealed when the server opens them. Session titles are visible (they are headings, not content).

## 4. Data model (migration `20261118120000_evaluations_paced`, additive; rollback SQL in its header)
`Evaluation.key` (unique per organization when set, lowercase slug), `EvaluationAnswer.openedAt / closedAt / closure` (`CONFIRMED | OMITTED | TIMEOUT`), `EvaluationResult.timedOut`.
The version snapshot carries `settings.pacing`; older versions without it read as `FREE`.

## 5. Importing the simulacro
`scripts/evaluations/lectura-critica-principito-01.mjs` is a *definition file* (data): title, description, settings, 3 sections (with their chapter text), 15 questions, 60 options, the key letter and explanation per question, assignments, publish flag.
`scripts/import-evaluation.mjs` runs the generic `scripts/lib/import-evaluation-core.mjs` through the normal API as the acting account (HTTP with a session, or `--in-process --actor <email>` on the server):
```
node scripts/import-evaluation.mjs scripts/evaluations/lectura-critica-principito-01.mjs --org stress-test --in-process --actor <email> --dist /app/dist
```
Idempotent by `key`: if it exists nothing is changed (the content then belongs to its editors); a failed import deletes the unpublished draft it created. After import everything is editable in Exam Builder / the API; changes to a published exam produce a new version on the next publication, and attempts keep the version they started on.
Settings of this exam: 30 min, 1 attempt per person, 120 s per question, `FORWARD_ONLY`, review `AFTER_SUBMIT`, no penalties, AI off. Assigned to roles MEMBER and VIEWER (data in the definition). The import requires `evaluations.create/update/publish/manage`; taking requires `evaluations.take` + assignment; reading results requires `evaluations.results.read`.

## 6. Verification
`tests/evaluations.test.ts` (unit: the state machine at the boundary, late reloads, carry-over, global deadline, grading with timeouts) and `tests/simulacro.integration.test.ts` (15 checks): import structure (3/5/15/60/15, key letters, settings), idempotency and cleanup of a failed import,
no key/explanation/other chapters in the attempt payload, the 30-minute cap, confirmation inside the window, **exact-limit acceptance and +1 ms rejection**, `omitted`, duplicates (same choice accepted, different refused), future/closed questions refused, parallel confirmations, late reload recovers nothing,
automatic end, a 5-minute variant bound by the global limit, review released only after closing with the four statuses, a complete 15/15 run (93.33 % with one wrong), statistics separating errors / omissions / timeouts, editing -> new version while attempts keep theirs, tenant isolation.
The importer was also run in-process against a fresh Stress Test twice (second run: nothing changed). NORTH is verified in a browser (see ADR 029 addendum / report).

## 7. Limits and open points
- Free-mode evaluations keep the 10 s network allowance; paced ones do not, by design: a request that *arrives* late because of latency is invalid. If that proves too strict, add an explicit `graceMs` setting rather than a hidden tolerance.
- `maxAttempts` was not specified; it is 1 here (strict simulacro) and can be changed in the settings.
- Competency labels are the questions' `category`; difficulty and duration per session are in the session description (plain text).
- Per-session time limits are implied by 5 x 120 s; there is no separate session timer.
- Question-level time spent is not stored beyond open/close timestamps (derivable).
