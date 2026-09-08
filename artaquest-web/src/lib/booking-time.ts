/**
 * Time and calendar arithmetic for the booking grids (the ArtaCast calendar). Every function here is
 * a COPY of the one in pages/Book.tsx, kept identical in behaviour so ArtaCast draws the host's free
 * days exactly as their own booking page does; Book.tsx is the original — change it there first.
 * Pure functions only: the components that draw with them live in components/cast/grid.tsx.
 */

export const VIEWER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

export const MON_FIRST = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAY_NAMES = MON_FIRST.map((i) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i))));

export const HOUR_OPTS: Intl.DateTimeFormatOptions = { hour12: true };

export function fmt(ts: number, opts: Intl.DateTimeFormatOptions, tz?: string): string {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
}

export function zoneName(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    .formatToParts(new Date(Number(ts) * 1000));
  return parts.find((p) => p.type === "timeZoneName")?.value || "";
}

export const clockOnly = (ts: number, tz: string) =>
  fmt(ts, { hour: "2-digit", minute: "2-digit", ...HOUR_OPTS }, tz);

export const longInstant = (ts: number, tz: string) =>
  fmt(ts, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short", ...HOUR_OPTS }, tz);

export function dayKey(ts: number, tz: string): string {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function minKey(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function dayHeading(key: string, withYear: boolean): string {
  const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
  return fmt(noon, { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }, "UTC");
}

export function dayHeadingLong(key: string): string {
  const noon = Math.round(Date.parse(key + "T12:00:00Z") / 1000);
  return fmt(noon, { weekday: "long", day: "numeric", month: "long" }, "UTC");
}

export const monthOf = (key: string) => key.slice(0, 7);
export const pad2 = (n: number) => String(n).padStart(2, "0");

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export const weekIndex = (key: string) => (new Date(key + "T12:00:00Z").getUTCDay() + 6) % 7;

export function monthLabel(month: string, withYear = true): string {
  const [y, m] = month.split("-").map(Number);
  return fmt(Math.round(Date.UTC(y, m - 1, 1, 12) / 1000), { month: "long", ...(withYear ? { year: "numeric" } : {}) }, "UTC");
}

export function monthCells(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = i - lead + 1;
    out.push(d >= 1 && d <= days ? `${month}-${pad2(d)}` : "");
  }
  return out;
}

export function sameDayIn(month: string, key: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad2(Math.min(Number(key.slice(8, 10)) || 1, last))}`;
}

