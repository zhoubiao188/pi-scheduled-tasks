/**
 * WorkBuddy-style repeat rules, compiled to the canonical schedule strings in
 * src/schedule.ts.
 *
 * The dialog asks for a repeat kind plus a time, the way an automation guide
 * describes it ("every day at 09:00", "every Monday, Wednesday and Friday"),
 * and this module turns that into a cron expression or interval. Everything is
 * validated through `parseSchedule`, so a rule that cannot run is rejected
 * here rather than stored and discovered later by the timer.
 */

import { parseSchedule, ScheduleError, type ParsedSchedule } from "./schedule.ts";

export type RepeatKind = "daily" | "weekly" | "monthly" | "yearly" | "interval" | "once" | "cron";

export const REPEAT_KINDS: Array<{ kind: RepeatKind; label: string; hint: string }> = [
  { kind: "daily", label: "Every day", hint: "A time such as 09:00" },
  { kind: "weekly", label: "Every week", hint: "Weekdays such as mon,wed,fri and a time" },
  { kind: "monthly", label: "Every month", hint: "Days such as 1,15 and a time" },
  { kind: "yearly", label: "Every year", hint: "A date such as 12-01 and a time" },
  { kind: "interval", label: "Every N minutes or hours", hint: "Such as 30m, 2h or 1h30m" },
  { kind: "once", label: "Once", hint: "Such as 09:00 or 2026-11-26T09:00" },
  { kind: "cron", label: "Custom cron", hint: "A five-field expression" },
];

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

function clock(input: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new ScheduleError('Use a 24-hour time such as "09:00".');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new ScheduleError('Use a 24-hour time such as "09:00".');
  return { hours, minutes };
}

function numbers(input: string, min: number, max: number, what: string): number[] {
  const values = new Set<number>();
  for (const part of input.split(",")) {
    const text = part.trim();
    if (!text) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(text);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < min || end > max || start > end) throw new ScheduleError(`${what} must be between ${min} and ${max}.`);
      for (let value = start; value <= end; value++) values.add(value);
      continue;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ScheduleError(`${what} must be between ${min} and ${max}.`);
    }
    values.add(value);
  }
  if (values.size === 0) throw new ScheduleError(`Choose at least one ${what.replace(/s$/, "").toLowerCase()}.`);
  return [...values].sort((a, b) => a - b);
}

function weekdays(input: string): number[] {
  const values = new Set<number>();
  for (const part of input.split(/[,\s]+/)) {
    const text = part.trim().toLowerCase();
    if (!text) continue;
    const named = WEEKDAYS[text];
    const numeric = /^\d$/.exec(text) ? Number(text) % 7 : undefined;
    const value = named ?? numeric;
    if (value === undefined) {
      throw new ScheduleError('Use weekdays such as "mon,wed,fri".');
    }
    values.add(value);
  }
  if (values.size === 0) throw new ScheduleError("Choose at least one weekday.");
  return [...values].sort((a, b) => a - b);
}

function assertRealDate(month: number, day: number): void {
  // 2024 is a leap year, so 02-29 is accepted.
  const date = new Date(2024, month - 1, day);
  if (date.getDate() !== day || date.getMonth() !== month - 1) {
    throw new ScheduleError(`There is no ${month}/${day}.`);
  }
}

/** Compiles a repeat rule into the canonical schedule string. */
export function buildSchedule(
  kind: RepeatKind,
  input: { time?: string; days?: string; date?: string; interval?: string; at?: string; cron?: string },
  now = Date.now(),
): ParsedSchedule {
  switch (kind) {
    case "daily": {
      const { hours, minutes } = clock(input.time ?? "");
      return parseSchedule(`${minutes} ${hours} * * *`, now);
    }
    case "weekly": {
      const { hours, minutes } = clock(input.time ?? "");
      return parseSchedule(`${minutes} ${hours} * * ${weekdays(input.days ?? "").join(",")}`, now);
    }
    case "monthly": {
      const { hours, minutes } = clock(input.time ?? "");
      const days = numbers(input.days ?? "", 1, 31, "Days");
      return parseSchedule(`${minutes} ${hours} ${days.join(",")} * *`, now);
    }
    case "yearly": {
      const { hours, minutes } = clock(input.time ?? "");
      const date = /^(\d{1,2})-(\d{1,2})$/.exec((input.date ?? "").trim());
      if (!date) throw new ScheduleError('Use a month-day such as "12-01".');
      const month = Number(date[1]);
      const day = Number(date[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) throw new ScheduleError('Use a month-day such as "12-01".');
      assertRealDate(month, day);
      return parseSchedule(`${minutes} ${hours} ${day} ${month} *`, now);
    }
    case "interval": {
      // People type "30m" and "every 30m" for the same thing.
      const raw = (input.interval ?? "").trim().replace(/^every\s+/i, "");
      if (!/^\d/.test(raw)) throw new ScheduleError('Use an interval such as "30m" or "1h30m".');
      return parseSchedule(`every ${raw}`, now);
    }
    case "once":
      return parseSchedule(`at ${input.at ?? ""}`, now);
    case "cron":
      return parseSchedule(input.cron ?? "", now);
  }
}
