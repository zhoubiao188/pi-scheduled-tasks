import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findTask,
  loadStore,
  newTaskId,
  parseStore,
  removeTask,
  saveStore,
  upsertTask,
  validateTaskInput,
} from "../src/store.ts";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduled-tasks-test-"));
}

const valid = {
  title: "  Morning   cleanup ",
  prompt: " Summarize the inbox. ",
  schedule: "0 9 * * *",
  cwd: "/tmp",
  catchUp: false,
};

test("validateTaskInput normalises and validates", () => {
  const fields = validateTaskInput(valid);
  assert.equal(fields.title, "Morning cleanup");
  assert.equal(fields.prompt, "Summarize the inbox.");
  assert.equal(fields.enabled, true);

  assert.throws(() => validateTaskInput({ ...valid, title: "   " }), /name/);
  assert.throws(() => validateTaskInput({ ...valid, prompt: "" }), /prompt/);
  assert.throws(() => validateTaskInput({ ...valid, cwd: "" }), /directory/);
  assert.throws(() => validateTaskInput({ ...valid, schedule: "nope" }), /schedule|Unknown/);
  assert.throws(() => validateTaskInput({ ...valid, title: "x".repeat(200) }), /120/);
});

test("an end date and a model are validated", () => {
  const until = Date.now() + 86_400_000;
  const fields = validateTaskInput({ ...valid, until, model: "anthropic/claude-sonnet-4-6" });
  assert.equal(fields.until, until);
  assert.equal(fields.model, "anthropic/claude-sonnet-4-6");

  assert.equal(validateTaskInput({ ...valid, until: null, model: null }).model, null);
  assert.throws(() => validateTaskInput({ ...valid, until: Number.NaN }), /end date/);
  assert.throws(() => validateTaskInput({ ...valid, model: "bad model; rm -rf /" }), /model/);
});

test("store round-trips through disk with 0600", () => {
  const dir = tempDir();
  const file = path.join(dir, "scheduled-tasks.json");
  const task = {
    id: newTaskId(),
    ...validateTaskInput(valid),
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
    history: [],
  };
  const store = { version: 1, tasks: [task] };
  saveStore(file, store);

  const loaded = loadStore(file);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0].id, task.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a corrupt store is moved aside, never deleted", () => {
  const dir = tempDir();
  const file = path.join(dir, "scheduled-tasks.json");
  fs.writeFileSync(file, "{ not json");

  const store = loadStore(file);
  assert.deepEqual(store.tasks, []);
  assert.equal(fs.existsSync(file), false, "the corrupt file is moved away");
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{ not json");
});

test("parseStore drops invalid and duplicate tasks", () => {
  const good = {
    id: "abc123",
    title: "Keep me",
    prompt: "do it",
    schedule: "every 1h",
    cwd: "/tmp",
    enabled: true,
    catchUp: false,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    runs: 0,
    history: [],
  };
  const store = parseStore(
    JSON.stringify({
      version: 1,
      tasks: [
        good,
        { ...good },
        { ...good, id: "bad1", schedule: "not a schedule" },
        { ...good, id: "bad2", title: "" },
        null,
      ],
    }),
  );
  assert.deepEqual(store.tasks.map((task) => task.id), ["abc123"]);
  assert.deepEqual(store.tasks[0].history, []);
});

test("findTask, upsertTask and removeTask", () => {
  const store = { version: 1, tasks: [] };
  const task = {
    id: "t1",
    ...validateTaskInput(valid),
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    runs: 0,
    history: [],
  };
  upsertTask(store, task);
  assert.equal(findTask(store, "#t1")?.id, "t1");
  assert.equal(findTask(store, "nope"), undefined);
  assert.equal(removeTask(store, "nope"), false);
  assert.equal(removeTask(store, "t1"), true);
  assert.equal(store.tasks.length, 0);
});

test("history is bounded and newest-first", () => {
  const base = {
    id: "t1",
    title: "T",
    prompt: "p",
    schedule: "every 1h",
    cwd: "/tmp",
    enabled: true,
    catchUp: false,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    runs: 0,
    history: Array.from({ length: 40 }, (_, index) => ({ at: index, status: "ok" })),
  };
  const [task] = parseStore(JSON.stringify({ version: 1, tasks: [base] })).tasks;
  assert.equal(task.history.length, 20);
  assert.equal(task.history[0].at, 39);
});
