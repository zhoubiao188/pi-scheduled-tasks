import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Drives the extension through its real command handlers with a fake pi API
 * and fake dialogs. No model, no subprocess, no network: this checks the
 * wiring a person exercises from /tasks.
 */

function answers(overrides = {}) {
  const queues = { select: [], input: [], editor: [], confirm: [], ...overrides };
  return {
    ui: {
      select: async () => queues.select.shift(),
      input: async () => queues.input.shift(),
      editor: async () => queues.editor.shift(),
      confirm: async () => Boolean(queues.confirm.shift()),
      notify: (message, type) => record.notifications.push({ message, type }),
      setStatus: (key, text) => record.statuses.push({ key, text }),
      setWidget: (key, lines) => record.widgets.push({ key, lines }),
    },
    remaining: () => queues,
  };
}

const record = { notifications: [], statuses: [], widgets: [], sent: [] };

function fakeCtx(ui) {
  return {
    cwd: process.cwd(),
    ui,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    switchSession: async (file) => {
      record.switchedTo = file;
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduled-tasks-ext-"));
process.env.PI_SCHEDULED_TASKS_DIR = dir;
process.env.PI_SCHEDULED_TASKS_PI_BIN = "/definitely/not/installed/pi";

const { default: scheduledTasks } = await import("../extensions/scheduled-tasks.ts");

const commands = new Map();
const handlers = new Map();
const fakePi = {
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, options) => commands.set(name, options),
  sendUserMessage: (text, options) => record.sent.push({ text, options }),
};

scheduledTasks(fakePi);

const storeFile = path.join(dir, "scheduled-tasks.json");

function readStore() {
  if (!fs.existsSync(storeFile)) return { version: 1, tasks: [] };
  return JSON.parse(fs.readFileSync(storeFile, "utf8"));
}

test("session_start registers the scheduler and leaves an empty UI", async () => {
  const { ui } = answers();
  await handlers.get("session_start")({ type: "session_start" }, fakeCtx(ui));

  assert.ok(fs.existsSync(path.join(dir, "scheduled-tasks.lock")), "the first session becomes the leader");
  assert.deepEqual(readStore().tasks, []);
  assert.deepEqual(record.widgets, [], "an empty scheduler writes nothing to the UI");
  assert.deepEqual(record.statuses, []);
});

test("creating a task through the manager persists it", async () => {
  const { ui, remaining } = answers({
    confirm: [true],
    select: ["＋ New task", "Close"],
    input: ["Morning cleanup", "0 9 * * *", ""],
    editor: ["Summarize the inbox and list what needs a reply."],
  });
  await commands.get("tasks").handler("", fakeCtx(ui));

  const store = readStore();
  assert.equal(store.tasks.length, 1);
  const [task] = store.tasks;
  assert.equal(task.title, "Morning cleanup");
  assert.equal(task.schedule, "0 9 * * *");
  assert.equal(task.cwd, process.cwd());
  assert.equal(task.enabled, true);
  assert.ok(task.nextRunAt > Date.now());
  assert.equal(remaining().select.length, 0);
  assert.match(record.notifications.at(-1).message, /Created #/);
});

test("an invalid cron expression is refused without writing a task", async () => {
  const { ui } = answers({
    select: ["＋ New task", "Close"],
    input: ["Bad task", "every 30s", ""],
    editor: ["do something"],
  });
  const before = readStore().tasks.length;
  await commands.get("tasks").handler("add", fakeCtx(ui));

  assert.equal(readStore().tasks.length, before);
  assert.equal(record.notifications.at(-1).type, "error");
  assert.match(record.notifications.at(-1).message, /Unknown schedule|minute/i);
});

test("run now delivers into the session when no pi executable exists", async () => {
  const id = readStore().tasks[0].id;
  const { ui } = answers();
  await commands.get("tasks").handler(`run ${id}`, fakeCtx(ui));

  assert.deepEqual(record.sent.at(-1), {
    text: "Summarize the inbox and list what needs a reply.",
    options: undefined,
  });
  const task = readStore().tasks[0];
  assert.equal(task.runs, 1);
  assert.equal(task.history[0].status, "dispatched");
});

test("pause and resume flip the task without touching its history", async () => {
  const id = readStore().tasks[0].id;
  await commands.get("tasks").handler(`pause ${id}`, fakeCtx(answers().ui));
  let task = readStore().tasks[0];
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);

  await commands.get("tasks").handler(`resume ${id}`, fakeCtx(answers().ui));
  task = readStore().tasks[0];
  assert.equal(task.enabled, true);
  assert.ok(task.nextRunAt > Date.now());
  assert.equal(task.runs, 1);
});

test("the edit wizard keeps fields the user leaves empty", async () => {
  const id = readStore().tasks[0].id;
  const { ui } = answers({
    input: ["Renamed", "", ""],
    editor: ["New prompt"],
    select: ["Skip runs missed while pi was closed"],
  });
  await commands.get("tasks").handler(`edit ${id}`, fakeCtx(ui));

  const task = readStore().tasks[0];
  assert.equal(task.title, "Renamed");
  assert.equal(task.prompt, "New prompt");
  assert.equal(task.schedule, "0 9 * * *");
  assert.equal(task.catchUp, false);
});

test("list and show report what is stored", async () => {
  await commands.get("tasks").handler("list", fakeCtx(answers().ui));
  assert.match(record.notifications.at(-1).message, /Renamed/);

  const id = readStore().tasks[0].id;
  await commands.get("tasks").handler(`show ${id}`, fakeCtx(answers().ui));
  assert.match(record.notifications.at(-1).message, /New prompt/);
});

test("/at creates a one-off task from the composer", async () => {
  const { ui } = answers();
  const before = readStore().tasks.length;
  await commands.get("at").handler("09:00 Say good morning", fakeCtx(ui));

  const store = readStore();
  assert.equal(store.tasks.length, before + 1);
  const task = store.tasks.at(-1);
  assert.match(task.schedule, /^at \d{4}-\d{2}-\d{2}T09:00$/);
  assert.equal(task.prompt, "Say good morning");
});

test("delete removes the task and its history", async () => {
  const id = readStore().tasks[0].id;
  const { ui } = answers({ confirm: [true] });
  await commands.get("tasks").handler(`rm ${id}`, fakeCtx(ui));

  assert.equal(readStore().tasks.some((task) => task.id === id), false);
});

test("session_shutdown releases leadership and stops the timers", async () => {
  await handlers.get("session_shutdown")({ type: "session_shutdown" }, fakeCtx(answers().ui));
  assert.equal(fs.existsSync(path.join(dir, "scheduled-tasks.lock")), false);
});

function writeTask(fields) {
  const now = Date.now();
  const task = {
    id: "past1",
    title: "Overdue",
    prompt: "Do the overdue thing.",
    schedule: "every 1h",
    cwd: process.cwd(),
    enabled: true,
    catchUp: false,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now - 5 * 60_000,
    runs: 0,
    history: [],
    ...fields,
  };
  fs.writeFileSync(storeFile, JSON.stringify({ version: 1, tasks: [task] }));
  return task;
}

async function restartSession() {
  const { ui } = answers();
  await handlers.get("session_shutdown")({ type: "session_shutdown" }, fakeCtx(ui));
  await handlers.get("session_start")({ type: "session_start" }, fakeCtx(ui));
  await new Promise((resolve) => setTimeout(resolve, 250));
}

test("an overdue run with catch-up off is reported as missed, not fired", async () => {
  writeTask({ catchUp: false });
  const sentBefore = record.sent.length;
  await restartSession();

  const task = readStore().tasks[0];
  assert.equal(task.history[0].status, "missed");
  assert.equal(record.sent.length, sentBefore, "nothing is sent late");
  assert.ok(task.nextRunAt > Date.now(), "the schedule moves on");
  assert.equal(task.enabled, true);
});

test("an overdue run with catch-up on fires exactly once", async () => {
  writeTask({ catchUp: true });
  const sentBefore = record.sent.length;
  await restartSession();

  const task = readStore().tasks[0];
  assert.equal(task.history[0].status, "dispatched");
  assert.equal(record.sent.length, sentBefore + 1);
  assert.ok(task.nextRunAt > Date.now());
  assert.equal(task.history.length, 1, "one catch-up run, never a burst");
});

test("a one-off task disables itself once it has run", async () => {
  const target = Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
  const iso = new Date(target);
  const stamp = `${iso.getFullYear()}-${String(iso.getMonth() + 1).padStart(2, "0")}-${String(iso.getDate()).padStart(2, "0")}T${String(iso.getHours()).padStart(2, "0")}:${String(iso.getMinutes()).padStart(2, "0")}`;
  writeTask({ catchUp: true, schedule: `at ${stamp}` });
  await restartSession();

  const task = readStore().tasks[0];
  assert.equal(task.enabled, false);
  assert.equal(task.nextRunAt, null);
});
