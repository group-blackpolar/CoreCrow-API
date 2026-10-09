import type { DatasetQueryFilter } from "./query-contract.js";

/** Calendar maths on ISO dates (UTC, no time zones). A period is [from, to) — `to` exclusive. */
const DAY = 86_400_000;
const parse = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const format = (date: Date) => date.toISOString().slice(0, 10);
const isIsoDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parse(value).getTime());
const addDays = (iso: string, days: number) => format(new Date(parse(iso).getTime() + days * DAY));

function addMonths(iso: string, months: number) {
  const date = parse(iso);
  return format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate())));
}

function monthsBetween(from: string, to: string) {
  const a = parse(from);
  const b = parse(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * The period right before [from, to). Whole calendar months/years step back by the same number of calendar months
 * (so October compares with September, not with "the 31 days before"); any other range steps back by its own length.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } | null {
  if (!isIsoDate(from) || !isIsoDate(to) || from >= to) return null;
  if (from.endsWith("-01") && to.endsWith("-01")) {
    const months = monthsBetween(from, to);
    if (months >= 1) return { from: addMonths(from, -months), to: from };
  }
  const days = Math.round((parse(to).getTime() - parse(from).getTime()) / DAY);
  return { from: addDays(from, -days), to: from };
}

/** The closed date range a reader selected on `fieldId`, as [from, to), or null when the filters do not define one. */
export function selectedPeriod(filters: DatasetQueryFilter[], fieldId: string): { from: string; to: string } | null {
  const mine = filters.filter((filter) => filter.fieldId === fieldId);
  let from: string | null = null;
  let to: string | null = null;
  for (const filter of mine) {
    const value = filter.value;
    if (!isIsoDate(value)) return null;
    if (filter.operator === "GTE" || filter.operator === "GT") from = filter.operator === "GT" ? addDays(value, 1) : value;
    else if (filter.operator === "LT") to = value;
    else if (filter.operator === "LTE") to = addDays(value, 1);
    else if (filter.operator === "EQ") { from = value; to = addDays(value, 1); }
    else return null;
  }
  return from && to ? { from, to } : null;
}

/** The runtime filters with the date range replaced by `period` (other filters untouched). */
export function withPeriod(filters: DatasetQueryFilter[], fieldId: string, period: { from: string; to: string }): DatasetQueryFilter[] {
  return [
    ...filters.filter((filter) => filter.fieldId !== fieldId),
    { fieldId, operator: "GTE", value: period.from },
    { fieldId, operator: "LT", value: period.to },
  ];
}
