import assert from "node:assert/strict";
import test from "node:test";
import { buildSchedule } from "../src/recipes.ts";
import { ScheduleError } from "../src/schedule.ts";

const now = new Date(2026, 10, 25, 12, 0, 0, 0).getTime();

test("repeat rules compile to canonical schedules", () => {
  assert.equal(buildSchedule("daily", { time: "09:00" }, now).canonical, "0 9 * * *");
  assert.equal(buildSchedule("weekly", { days: "mon,wed,fri", time: "09:30" }, now).canonical, "30 9 * * 1,3,5");
  assert.equal(buildSchedule("weekly", { days: "monday 7", time: "18:00" }, now).canonical, "0 18 * * 0,1");
  assert.equal(buildSchedule("monthly", { days: "1,15", time: "08:05" }, now).canonical, "5 8 1,15 * *");
  assert.equal(buildSchedule("monthly", { days: "1-3", time: "08:05" }, now).canonical, "5 8 1,2,3 * *");
  assert.equal(buildSchedule("yearly", { date: "12-01", time: "09:00" }, now).canonical, "0 9 1 12 *");
  assert.equal(buildSchedule("interval", { interval: "30m" }, now).canonical, "every 30m");
  assert.equal(buildSchedule("cron", { cron: "0 9 * * mon-fri" }, now).canonical, "0 9 * * mon-fri");
});

test("a one-off rule resolves its date", () => {
  const parsed = buildSchedule("once", { at: "09:00" }, now);
  assert.equal(parsed.canonical, "at 2026-11-26T09:00");
  assert.equal(parsed.schedule.kind, "at");
});

test("repeat rules reject what a person cannot mean", () => {
  const cases = [
    () => buildSchedule("daily", { time: "9" }, now),
    () => buildSchedule("daily", { time: "24:00" }, now),
    () => buildSchedule("weekly", { days: "funday", time: "09:00" }, now),
    () => buildSchedule("weekly", { days: "", time: "09:00" }, now),
    () => buildSchedule("monthly", { days: "32", time: "09:00" }, now),
    () => buildSchedule("yearly", { date: "2-30", time: "09:00" }, now),
    () => buildSchedule("yearly", { date: "13-01", time: "09:00" }, now),
    () => buildSchedule("interval", { interval: "30s" }, now),
    () => buildSchedule("interval", { interval: "soon" }, now),
    () => buildSchedule("cron", { cron: "" }, now),
    () => buildSchedule("once", { at: "tomorrow" }, now),
  ];
  for (const run of cases) assert.throws(run, ScheduleError);
});
