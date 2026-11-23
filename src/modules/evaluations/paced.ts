/**
 * Pure state machine of a PACED (forward-only) attempt. Time is decided here and only from server timestamps:
 * - question i opens at the instant question i-1 closed (confirmation time, or its deadline when it timed out), so unused time is never carried over;
 * - it closes by timeout at openedAt + questionSeconds, bounded by the attempt's global deadline, whether or not anyone is looking;
 * - a confirmation at exactly the limit is valid, one millisecond later is not;
 * - reloading, switching tabs or asking later cannot recover time: the outcome depends on timestamps, never on when the client asks.
 */
export type Closure = "CONFIRMED" | "OMITTED" | "TIMEOUT";
export type PacedRow = { questionId: string; openedAt: Date; closedAt: Date | null; closure: Closure | null };
export type PacedPlan = {
  /** Questions that timed out and must be closed now (in order), with the instant they closed. */
  timeouts: Array<{ questionId: string; openedAt: Date; closedAt: Date }>;
  /** The question open at `now`, with its deadline; null when the attempt is over. */
  current: { questionId: string; openedAt: Date; expiresAt: Date | null } | null;
  /** Questions never reached before the global deadline (they count as not confirmed in time). */
  unreached: string[];
  finished: "NONE" | "ALL_CLOSED" | "GLOBAL_DEADLINE";
};

export function planPaced(input: { questionIds: readonly string[]; rows: readonly PacedRow[]; startedAt: Date; questionMs: number | null; globalDeadline: Date | null; now: Date;
  /** Optional per-session limit: `sectionOf[i]` is the section of question i; a session starts when its first question opens and lasts `sessionMs`. */
  sectionOf?: readonly string[]; sessionMs?: number | null }): PacedPlan {
  const { questionIds, startedAt, questionMs, globalDeadline, now, sectionOf, sessionMs } = input;
  let sessionKey: string | undefined;
  let sessionEnd: number | null = null;
  const byQuestion = new Map(input.rows.map((row) => [row.questionId, row]));
  const timeouts: PacedPlan["timeouts"] = [];
  let openedAt = startedAt;
  for (let index = 0; index < questionIds.length; index += 1) {
    const questionId = questionIds[index]!;
    const row = byQuestion.get(questionId);
    const start = row?.openedAt ?? openedAt;
    if (sectionOf && sessionMs && sectionOf[index] !== sessionKey) { sessionKey = sectionOf[index]; sessionEnd = start.getTime() + sessionMs; }
    if (row?.closedAt) { openedAt = row.closedAt; continue; }
    const limits = [questionMs === null ? null : start.getTime() + questionMs, globalDeadline?.getTime() ?? null, sessionMs ? sessionEnd : null].filter((value): value is number => value !== null);
    const end = limits.length ? Math.min(...limits) : null;
    // Strictly after the limit: a request arriving exactly at it is still on time.
    if (end !== null && now.getTime() > end) {
      timeouts.push({ questionId, openedAt: start, closedAt: new Date(end) });
      openedAt = new Date(end);
      if (globalDeadline && end >= globalDeadline.getTime()) return { timeouts, current: null, unreached: questionIds.slice(index + 1), finished: "GLOBAL_DEADLINE" };
      continue;
    }
    return { timeouts, current: { questionId, openedAt: start, expiresAt: end === null ? null : new Date(end) }, unreached: [], finished: "NONE" };
  }
  return { timeouts, current: null, unreached: [], finished: "ALL_CLOSED" };
}
