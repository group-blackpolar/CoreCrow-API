# 032 — Stress Test rework: categories, competencies, personalised feedback and Simulacro 02

Status: implemented and tested locally (2026-11-23). Not deployed. Builds on ADR 029 (engine) and 030 (paced exams). Nothing about a specific exam or category lives in code:
categories, the exam, its skills and its thresholds are **data** imported through the API.

## 1. Audit (what already existed and was reused)
Server-authoritative engine in `src/modules/evaluations` (immutable versions with the key, one open attempt per person, seq-guarded autosave, paced/forward-only mode with
server timestamps, `invalid_timeout`, per-category/section breakdown, statistics, review policy, organization isolation, `evaluations.*` permissions split between
authors (`create/update/publish/manage/results.read`) and takers (`take`)). NORTH had Builder, Player (`PacedPlayer`, one question per screen, passage in a bottom sheet) and Results.
**Reused unchanged:** all of the above, the importer (`scripts/import-evaluation.mjs`), the permission model. **Missing (this ADR):** categories, a per-session limit, per-question
tags (topic, skills, difficulty, reference), configurable performance levels, a feedback service, the new result page, the category UI and Simulacro 02.

## 2. Data model (migration `20261123120000_evaluation_categories`, additive; rollback SQL in its header)
- `EvaluationCategory` (organization, unique `key`, name, description, colour `#rrggbb`, optional `imageAssetId` = a North asset of the organization, status ACTIVE/ARCHIVED, position) and
  `Evaluation.categoryId` (composite FK with the organization). Changing the category is metadata (`PUT /evaluations/:id/category`): it does not create an unpublished revision.
- `EvaluationFeedback` (append-only, unique `(attemptId, version)`): generator, content (JSON), reason (`AUTO | BACKFILL | REGENERATED`), who and when.
- Inside the immutable version snapshot (content schema, all with defaults so old versions still parse): `questions[].topic|skills|difficulty|reference`, `skills[]`
  (`id, competency, label, strength, gap, study, strategy`), `settings.performance.levels[]` (`key, label, minPercent, summary?`), `settings.pacing.sessionMinutes`.
- Mapping to the brief's conceptual entities: ExamVersion = `EvaluationVersion`; ExamSession = section; QuestionCompetency = `question.category` (+ skills); SessionAttempt =
  `EvaluationAnswer` rows grouped by section; QuestionResponse = `EvaluationAnswer`; CompetencyResult = `EvaluationResult.breakdown.byCategory` + feedback; ExamFeedback = `EvaluationFeedback`.

## 3. Categories
`GET /evaluation-categories` (needs `evaluations.take` or `.read`) returns the categories **with the caller's own numbers** (assigned exams, completed, in progress; and the
assigned exams that have no category). `POST`, `PATCH` and the idempotent initializer `PUT /evaluation-categories/by-key/:key` need `evaluations.manage`.
`scripts/evaluations/categories.mjs` (data) holds Lectura Crítica and Inglés; `node scripts/import-evaluation.mjs scripts/evaluations/categories.mjs --org <slug> ...` creates the missing
ones and never modifies an existing one (running it twice creates no duplicates; a concurrent initializer loses the unique key and becomes a no-op). It also assigns listed
evaluation keys that have no category yet. Inglés has no exams: the UI shows an empty state.

## 4. Time policy (all decided by the server from timestamps; the browser clock is never authoritative)
Unchanged from ADR 030 plus the **session limit**: `pacing.sessionMinutes` (30 for Simulacro 02) starts when the first question of a session opens and bounds each question of that
session (`min(openedAt + 120 s, sessionStart + 30 min, global deadline)`). It never extends the 120 s of a question. The global `durationMinutes` of Simulacro 02 is 90 (3 x 30).
- Reload, closing the tab, another device or a reconnection **never restart or recover time**: the open question has one `openedAt`; every entry point first closes what already expired, each at its own deadline.
- **Interrupted attempts policy:** an attempt in progress is never paused. If the person leaves, each question expires at its own deadline (0 points, `invalid_timeout`) and the attempt ends
  (graded) when the last window or the global deadline passes; opening it later shows the result. There is no manual pause, and a closed attempt cannot be resumed.
- Autosave of the selection is a draft; only `POST .../confirm` counts. Time spent per question (`closedAt - openedAt`) is stored in the answer rows and exposed in the result/review.

## 5. Grading, levels, results
Grading is unchanged (integer centi-points, per question weight 1, omitted/timed-out = 0). The level of a percentage is the highest level whose `minPercent` it reaches, from the
version's own table (Simulacro 02: Bajo 0, Básico 40, Alto 60, Superior 80). **It is an internal classification, not an official ICFES scale** (the UI says so).
The result payload now carries `feedback` (latest version: overall level, per-competency score/percent/level/time/hits/topics/paragraph, improvement plan, and for result readers the version
list) and `levels`. The review items add competency, topic, difficulty, reference and seconds. The correct answers/explanations still leave the server only when the version's review policy allows it.

## 6. Feedback service (`feedback.ts`, pure and reusable by every category)
Deterministic generator `deterministic-v1`. Input: the pinned version (questions, skills, thresholds) and the attempt's real outcome and time per question. For each competency it assembles:
level sentence (+ the level's own `summary`), skills **dominated** (every tagged question right), skills **with gaps** (with the question numbers), unanswered/timed-out questions, what to study
and strategies for the failed skills (top 3 by number of failures); with no failures, consolidation strategies. The **improvement plan** has 3 to 5 items: failed skills ranked by failures and by
the weakest competency, completed with consolidation items. Only skills tagged on the exam appear, so it cannot invent errors; the wording of strengths/gaps/study/strategy is data authored with the exam.
Two students with the same percentage and different mistakes receive different paragraphs (unit-tested). It is persisted as version 1 when the attempt is graded (same transaction); attempts closed before this
existed get a `BACKFILL` version on first view. `POST /evaluation-attempts/:id/feedback/regenerate` (needs `evaluations.manage`) appends a version only if the output differs from the latest one, audited; grades never change.
**AI-assisted feedback is NOT implemented**: the module does not expose a feedback service that is authorized for this use, and no fictitious dependency was added. The `generator` column and the pure
input/output contract are where it would plug in (with this generator as the fallback; never touching grades; evidence-only prompts).

## 7. Simulacro 02 (`scripts/evaluations/lectura-critica-naranja-lima-02.mjs`)
Exact title "Lectura Critica - Mi planta naranja-lima | Simulacro 02", category `lectura-critica`, 3 sessions x 5 questions (15 q, 60 options, keys B D A C B | D A C B D | C A B D C), the fragment visible in the
five questions of session 2, 14 skills, thresholds, 120 s/question, 30 min/session, 1 attempt, review after submit, assigned to MEMBER and VIEWER. Competencies: Comprensión literal (1-5), inferencial (6-10), lectura crítica (11-15).
Page references are not invented: `reference` names the chapter only.

## 8. Concurrency finding (found by the load test, fixed here)
`scripts/load-test-evaluation.mjs` (real HTTP, N students with their own sessions) showed that with 10-20 simultaneous students the attempt endpoints failed with HTTP 500 (`P2034`, Serializable
serialization failures after 3 retries): unrelated students aborted each other (13-16 of 20 failed; 4-8 % of requests). The attempt operations now run READ COMMITTED behind a transaction-scoped advisory lock per attempt
(per person and evaluation when starting): the same attempt is serialized (one confirmation wins, a repeat sees the closed question), different attempts never wait. After the change: 20 concurrent students, 0 errors, all results consistent.
**Open risk:** the default per-IP rate limit (100 requests/min) is shared by a class behind one NAT; with a single client IP the load test gets HTTP 429 for most students. Not changed here (policy decision): consider keying the limit by user for authenticated routes.

## 9. Verification
`tests/evaluations-feedback.test.ts` (8 unit: definition integrity, perfect run, thresholds, same % different mistakes, no invented skills, timeouts, determinism, per-session limit),
`tests/stress-test-rework.integration.test.ts` (13: idempotent categories + permissions, import, counts, no key leak, reload/second device keep the timer, timeout after 121 s, 12/15 = 80 %, per-competency levels and paragraphs,
review incl. seconds, history, feedback versions + regeneration, edit after finished attempts keeps history, cross-organization isolation + concurrent confirmations, archiving). Existing evaluations/simulacro/authorization-matrix suites pass.
Browser (local stack, Chromium pane): category cards, category page, intro with sessions, full run, result (desktop 1280 and mobile 375, no horizontal overflow), builder (categories, skills, levels, tags).
**Not verified:** production deployment and migration; a physical phone; the keyboard-on-screen behaviour and orientation changes beyond the existing player; per-device image rendering of category images (no image was uploaded);
load above 20 concurrent students; server CPU/memory under load (the script reports client-side numbers only).

## 10. Not done / decisions to confirm
- A separate "results publication date" (hiding the grade itself) is not implemented: the existing review policy (`NEVER | AFTER_SUBMIT | AFTER_DATE`) governs when answers/explanations are shown; the grade and feedback are shown on finishing.
- `difficulty` can be set but not cleared through the API (nullable enums are not representable in the route schema).
- Inglés and any other category have no exam; nothing was invented.
