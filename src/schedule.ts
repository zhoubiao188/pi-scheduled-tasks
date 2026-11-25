/**
 * Schedule parsing and next-run arithmetic.
 *
 * Three forms, all stored in their canonical string shape so a task file
 * stays readable and diffable:
 *
 *   cron    "0 9 * * *"            five fields, local time, @macros accepted
 *   every   "every 30m"            45s, 30m, 2h, 1h30m, 1d (minimum one minute)
 *   at      "at 2026-11-26T09:00"  once, local time
 *
 * Pure: no I/O, no dependency, no clock of its own.
 */

export type CronSpec = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
};

export type Schedule =
  | { kind: "cron"; expr: string; spec: CronSpec }
  | { kind: "every"; everyMs: number; label: string }
  | { kind: "at"; at: number };

export class ScheduleError extends Error {}

const MIN_INTERVAL_MS = 60_000;
const MAX_CRON_SEARCH_MS = 366 * 24 * 60 * 60 * 1000; // a year without a match is a bug or a dead date

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const INTERVAL_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function isFullRange(values: number[], min: number, max: number): boolean {
  return values.length === max - min + 1 && values[0] === min && values[values.length - 1] === max;
}

function expandField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): number[] | null {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    if (!part) return null;
    const [rangeText, stepText, extra] = part.split("/");
    if (extra !== undefined) return null;

    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    const read = (token: string): number | null => {
      const named = names?.[token.toLowerCase()];
      const value = named ?? Number(token);
      if (!Number.isInteger(value)) return null;
      // Sunday is written 0 and 7; normalise to 0.
      const normalised = max === 6 && value === 7 ? 0 : value;
      return normalised >= min && normalised <= max ? normalised : null;
    };

    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else {
      const [startText, endText, rest] = rangeText.split("-");
      if (rest !== undefined) return null;
      const parsedStart = read(startText);
      if (parsedStart === null) return null;
      start = parsedStart;
      if (endText === undefined) {
        // "5/15" means "from 5 to the end of the field, every 15".
        end = stepText === undefined ? start : max;
      } else {
        const parsedEnd = read(endText);
        if (parsedEnd === null) return null;
        end = parsedEnd;
      }
    }

    if (start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) return null;
  return [...values].sort((a, b) => a - b);
}

export function parseCron(input: string): CronSpec | null {
  const trimmed = input.trim().replace(/\s+/g, " ");
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(" ");
  if (fields.length !== 5) return null;

  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  const daysOfMonth = expandField(fields[2], 1, 31);
  const months = expandField(fields[3], 1, 12, MONTH_NAMES);
  const daysOfWeek = expandField(fields[4], 0, 6, DOW_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const domRestricted = !isFullRange(spec.daysOfMonth, 1, 31);
  const dowRestricted = !isFullRange(spec.daysOfWeek, 0, 6);
  const domMatch = spec.daysOfMonth.includes(date.getDate());
  const dowMatch = spec.daysOfWeek.includes(date.getDay());
  // Vixie cron: when both day fields are restricted, either one matching is enough.
  return domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
}

/** First run strictly after `after`, in the process's local time. */
export function nextCronRun(spec: CronSpec, after: number): number | null {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after + MAX_CRON_SEARCH_MS;

  while (date.getTime() <= limit) {
    if (!spec.months.includes(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.includes(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.includes(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}

function parseEvery(raw: string): { everyMs: number; label: string } | null {
  const text = raw.replace(/^every\s+/i, "").trim().toLowerCase();
  if (!/^(?:\d+[smhd])+$/.test(text)) return null;

  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhd])/g)) {
    total += Number(amount) * INTERVAL_UNITS[unit];
  }
  if (!Number.isFinite(total) || total < MIN_INTERVAL_MS) return null;
  return { everyMs: total, label: `every ${text}` };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseAt(raw: string, now: number): { at: number } | null {
  const text = raw.replace(/^at\s+/i, "").trim();

  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return { at: date.getTime() };
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const at = Date.parse(text);
    return Number.isFinite(at) ? { at } : null;
  }
  return null;
}

export type ParsedSchedule = { schedule: Schedule; canonical: string };

/**
 * Parses a user-entered schedule. Throws `ScheduleError` with a message meant
 * for the person who typed it.
 */
export function parseSchedule(input: string, now = Date.now()): ParsedSchedule {
  const raw = input.trim();
  if (!raw) throw new ScheduleError("Enter a schedule: a cron expression, \"every 30m\", or \"at 09:00\".");

  const cronSpec = parseCron(raw);
  if (cronSpec) {
    return { schedule: { kind: "cron", expr: raw, spec: cronSpec }, canonical: raw };
  }

  const every = parseEvery(raw);
  if (every) {
    return { schedule: { kind: "every", ...every }, canonical: every.label };
  }

  const at = parseAt(raw, now);
  if (at) {
    return { schedule: { kind: "at", at: at.at }, canonical: `at ${localIso(new Date(at.at))}` };
  }

  throw new ScheduleError(
    "Unknown schedule. Use a five-field cron expression (\"0 9 * * *\"), \"every 30m\", or \"at 2026-11-26T09:00\".",
  );
}

function parseCanonical(raw: string, now: number): Schedule {
  const cronSpec = parseCron(raw);
  if (cronSpec) return { kind: "cron", expr: raw, spec: cronSpec };

  const every = parseEvery(raw);
  if (every) return { kind: "every", ...every };

  const text = raw.replace(/^at\s+/i, "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return { kind: "at", at };
  }
  throw new ScheduleError(`Stored schedule "${raw}" is no longer valid.`);
}

/**
 * Next occurrence strictly after `after`.
 *
 * An interval advances from its previous scheduled time when that is still
 * close to `after`, so a slow run does not push every later run back.
 */
export function nextRunAt(schedule: Schedule | string, after: number): number | null {
  const parsed = typeof schedule === "string" ? parseCanonical(schedule, after) : schedule;
  switch (parsed.kind) {
    case "cron":
      return nextCronRun(parsed.spec, after);
    case "every":
      return after + parsed.everyMs;
    case "at":
      return parsed.at > after ? parsed.at : null;
  }
}

/** Where the next run lands, for the widget and dialogs. */
export function describeSchedule(schedule: Schedule | string, now = Date.now()): string {
  const parsed = typeof schedule === "string" ? parseCanonical(schedule, now) : schedule;
  switch (parsed.kind) {
    case "cron":
      return `cron ${parsed.expr}`;
    case "every":
      return parsed.label;
    case "at":
      return `once ${formatDateTime(parsed.at)}`;
  }
}

export function formatDateTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
}

export function formatRelative(at: number, now = Date.now()): string {
  const delta = at - now;
  const future = delta >= 0;
  const seconds = Math.abs(Math.round(delta / 1000));
  const units: Array<[string, number]> = [["d", 86_400], ["h", 3_600], ["m", 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) return future ? `in ${Math.floor(seconds / size)}${unit}` : `${Math.floor(seconds / size)}${unit} ago`;
  }
  return future ? "in <1m" : "<1m ago";
}
