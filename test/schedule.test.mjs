import assert from "node:assert/strict";
import test from "node:test";
import {
  ScheduleError,
  describeSchedule,
  formatDateTime,
  formatRelative,
  nextCronRun,
  nextRunAt,
  parseCron,
  parseSchedule,
} from "../src/schedule.ts";

const at = (year, month, day, hours = 0, minutes = 0) => new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();

test("parseCron expands fields, steps, ranges and names", () => {
  assert.deepEqual(parseCron("0 9 * * *"), {
    minutes: [0],
    hours: [9],
    daysOfMonth: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  });
  assert.deepEqual(parseCron("*/15 * * * *").minutes, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("0 9 * * mon-fri").daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("0 0 1 jan *").months, [1]);
  assert.deepEqual(parseCron("0 0 * * 7").daysOfWeek, [0], "Sunday may be written 7");
  assert.deepEqual(parseCron("@daily").hours, [0]);
  assert.deepEqual(parseCron("5/15 * * * *").minutes, [5, 20, 35, 50]);
});

test("parseCron rejects malformed expressions", () => {
  for (const expression of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "abc", "1-2-3 * * * *", "* * * * */x"]) {
    assert.equal(parseCron(expression), null, expression);
  }
});

test("nextCronRun finds the next matching minute", () => {
  const daily = parseCron("0 9 * * *");
  const next = new Date(nextCronRun(daily, at(2026, 11, 25, 12, 0)));
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [26, 9, 0]);

  const quarter = parseCron("*/15 * * * *");
  const soon = new Date(nextCronRun(quarter, at(2026, 11, 25, 12, 7)));
  assert.deepEqual([soon.getHours(), soon.getMinutes()], [12, 15]);

  // 2026-11-27 is a Friday; the next weekday-only run is Monday 09:00.
  const weekdays = parseCron("0 9 * * 1-5");
  const monday = new Date(nextCronRun(weekdays, at(2026, 11, 27, 18, 0)));
  assert.deepEqual([monday.getDay(), monday.getDate(), monday.getHours()], [1, 30, 9]);
});

test("nextCronRun treats restricted day-of-month and day-of-week as either/or", () => {
  // The 1st of the month OR any Monday, whichever comes first after Nov 25 2026.
  const spec = parseCron("0 0 1 * mon");
  const next = new Date(nextCronRun(spec, at(2026, 11, 25, 12, 0)));
  assert.deepEqual([next.getMonth() + 1, next.getDate()], [11, 30], "Monday Nov 30 comes before Dec 1");
});

test("nextCronRun returns null instead of searching forever", () => {
  // February 30 never exists.
  assert.equal(nextCronRun(parseCron("0 0 30 2 *"), at(2026, 1, 1)), null);
});

test("parseSchedule accepts the three documented forms", () => {
  const now = at(2026, 11, 25, 12, 0);

  const every = parseSchedule("every 1h30m", now);
  assert.equal(every.canonical, "every 1h30m");
  assert.equal(nextRunAt(every.schedule, now), now + 90 * 60_000);

  const bare = parseSchedule("30m", now);
  assert.equal(bare.canonical, "every 30m");

  const cron = parseSchedule("0 9 * * *", now);
  assert.equal(cron.canonical, "0 9 * * *");

  const clock = parseSchedule("at 09:00", now);
  assert.equal(clock.canonical, "at 2026-11-26T09:00", "a past clock time lands tomorrow");
  assert.equal(nextRunAt(clock.schedule, now), at(2026, 11, 26, 9, 0));

  const absolute = parseSchedule("2026-12-01T08:30", now);
  assert.equal(absolute.canonical, "at 2026-12-01T08:30");
});

test("parseSchedule rejects what it cannot run", () => {
  const now = at(2026, 11, 25, 12, 0);
  for (const input of ["", "   ", "every 30s", "every 0m", "at 25:00", "tomorrow", "* * * *"]) {
    assert.throws(() => parseSchedule(input, now), ScheduleError, JSON.stringify(input));
  }
});

test("one-off schedules have no next run after they fire", () => {
  const at9 = parseSchedule("at 2026-11-26T09:00");
  assert.equal(nextRunAt(at9.schedule, at(2026, 11, 26, 9, 0)), null);
  assert.equal(nextRunAt(at9.schedule, at(2026, 11, 26, 8, 59)), at(2026, 11, 26, 9, 0));
});

test("describeSchedule and the time formatters stay readable", () => {
  const now = at(2026, 11, 25, 12, 0);
  assert.equal(describeSchedule("0 9 * * *", now), "every day at 09:00");
  assert.equal(describeSchedule("30 8 * * 1,3,5", now), "every Mon, Wed, Fri at 08:30");
  assert.equal(describeSchedule("0 9 * * 1-5", now), "every weekday at 09:00");
  assert.equal(describeSchedule("0 9 1,15 * *", now), "every month on days 1, 15 at 09:00");
  assert.equal(describeSchedule("0 9 1 12 *", now), "every year on Dec 1 at 09:00");
  assert.equal(describeSchedule("*/5 * * * *", now), "cron */5 * * * *");
  assert.equal(describeSchedule("every 2d", now), "every 2d");
  assert.equal(describeSchedule("at 2026-11-26T09:00", now), "once tomorrow 09:00");
  assert.equal(describeSchedule("at 2026-12-01T09:00", now), "once 12/01 09:00");
  assert.equal(formatDateTime(at(2026, 11, 25, 9, 5), now), "09:05");
  assert.equal(formatDateTime(at(2026, 11, 26, 9, 5), now), "tomorrow 09:05");
  assert.equal(formatRelative(now + 90_000, now), "in 1m");
  assert.equal(formatRelative(now - 3 * 3_600_000, now), "3h ago");
});
