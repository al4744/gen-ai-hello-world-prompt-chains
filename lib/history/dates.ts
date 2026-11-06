/** Require an absolute ISO timestamp so parsing never guesses a host timezone. */
export function parseHistoryTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Date parsing can silently roll February 30 into March. Reject impossible
  // calendar dates, validating in UTC rather than a host-local midnight.
  const calendarDay = value.slice(0, 10);
  if (new Date(`${calendarDay}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDay) return null;
  return date;
}

/** Call in the browser after hydration; no server timezone or cached formatter. */
export function formatLocalHistoryTime(value: string | null | undefined): string {
  const date = parseHistoryTimestamp(value);
  if (!date) return "Unavailable";
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      hour12: true, timeZoneName: "short",
      // Omitting timeZone uses the browser's current local timezone, including DST.
    }).format(date);
  } catch { return "Unavailable"; }
}
