"use client";

import { useSyncExternalStore } from "react";
import { formatLocalHistoryTime, parseHistoryTimestamp } from "@/lib/history/dates";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export default function LocalDateTime({ value, prefix = "", className }: {
  value?: string | null; prefix?: string; className?: string;
}) {
  // React uses serverSnapshot for SSR and the first hydration render, then
  // clientSnapshot. Formatting never runs in the server's timezone.
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const valid = parseHistoryTimestamp(value) !== null;
  if (!valid) return <span className={className}>{prefix}Unavailable</span>;
  return <time dateTime={value ?? undefined} className={className}>
    {prefix}{hydrated ? formatLocalHistoryTime(value) : "Loading local time…"}
  </time>;
}
