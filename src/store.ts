/**
 * Task persistence.
 *
 * One JSON file per user, written atomically with mode 0600. The file is a
 * plain document rather than a database so a user can read, back up and diff
 * it, and so a corrupt file never takes the extension down: it is moved aside
 * and a fresh store is started.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseSchedule, ScheduleError } from "./schedule.ts";

export const STORE_VERSION = 1;
export const MAX_TASKS = 50;
export const MAX_TITLE_LENGTH = 120;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_HISTORY = 20;

export type RunStatus = "ok" | "error" | "missed" | "skipped" | "dispatched";

export interface RunRecord {
  at: number;
  status: RunStatus;
  durationMs?: number;
  summary?: string;
  error?: string;
  sessionFile?: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  /** Canonical schedule string; see src/schedule.ts. */
  schedule: string;
  cwd: string;
  /** Last moment this task may start, or null for no end date. */
  until: number | null;
  /** Optional `--model` pattern for the run. */
  model: string | null;
  enabled: boolean;
  catchUp: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  runs: number;
  /** Newest first, bounded by MAX_HISTORY. */
  history: RunRecord[];
}

export interface TaskStore {
  version: number;
  tasks: ScheduledTask[];
}

export function emptyStore(): TaskStore {
  return { version: STORE_VERSION, tasks: [] };
}

export function newTaskId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value)) return false;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  return ["ok", "error", "missed", "skipped", "dispatched"].includes(String(value.status));
}

function readTask(value: unknown): ScheduledTask | null {
  if (!isRecord(value)) return null;
  const { id, title, prompt, schedule, cwd, until, model, enabled, catchUp, createdAt, updatedAt, nextRunAt, runs, history } = value;
  if (typeof id !== "string" || !id) return null;
  if (typeof title !== "string" || !title.trim()) return null;
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  if (typeof schedule !== "string" || !schedule.trim()) return null;
  if (typeof cwd !== "string" || !cwd) return null;
  try {
    parseSchedule(schedule, Date.now());
  } catch (error) {
    if (error instanceof ScheduleError) return null;
    throw error;
  }
  return {
    id,
    title: title.slice(0, MAX_TITLE_LENGTH),
    prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
    schedule,
    cwd,
    until: typeof until === "number" && Number.isFinite(until) ? until : null,
    model: typeof model === "string" && model.trim() ? model.trim().slice(0, 200) : null,
    enabled: enabled !== false,
    catchUp: catchUp === true,
    createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
    updatedAt: typeof updatedAt === "number" ? updatedAt : Date.now(),
    nextRunAt: typeof nextRunAt === "number" && Number.isFinite(nextRunAt) ? nextRunAt : null,
    runs: typeof runs === "number" && Number.isFinite(runs) && runs >= 0 ? Math.floor(runs) : 0,
    history: Array.isArray(history)
      ? history.filter(isRunRecord).sort((a, b) => b.at - a.at).slice(0, MAX_HISTORY)
      : [],
  };
}

/** Parses a store document, dropping tasks that no longer validate. */
export function parseStore(text: string): TaskStore {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.tasks)) throw new Error("not a task store");
  const tasks: ScheduledTask[] = [];
  const seen = new Set<string>();
  for (const entry of data.tasks) {
    const task = readTask(entry);
    if (task && !seen.has(task.id)) {
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return { version: STORE_VERSION, tasks: tasks.slice(0, MAX_TASKS) };
}

export function loadStore(file: string): TaskStore {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }

  try {
    return parseStore(text);
  } catch {
    // Keep the unreadable file for the user instead of deleting their tasks.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // A read-only directory still must not break session start.
    }
    return emptyStore();
  }
}

/** Atomic write: a temp file in the same directory, then rename. */
export function saveStore(file: string, store: TaskStore): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify({ version: STORE_VERSION, tasks: store.tasks.slice(0, MAX_TASKS) }, null, 2)}\n`;
  fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

export async function saveStoreAsync(file: string, store: TaskStore): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify({ version: STORE_VERSION, tasks: store.tasks.slice(0, MAX_TASKS) }, null, 2)}\n`;
  await fsp.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

export type TaskInput = {
  title: string;
  prompt: string;
  schedule: string;
  cwd: string;
  catchUp: boolean;
  until?: number | null;
  model?: string | null;
};

/** Validates user input and returns the fields worth storing. */
export function validateTaskInput(input: TaskInput, now = Date.now()): Omit<ScheduledTask, "id" | "createdAt" | "updatedAt" | "nextRunAt" | "runs" | "history"> {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("A task needs a name.");
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`The name is longer than ${MAX_TITLE_LENGTH} characters.`);

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("A task needs a prompt to send.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`The prompt is longer than ${MAX_PROMPT_LENGTH} characters.`);

  const cwd = input.cwd.trim();
  if (!cwd) throw new Error("A task needs a working directory.");
  if (cwd.length > 4096) throw new Error("The working directory path is too long.");

  const until = input.until == null ? null : input.until;
  if (until !== null && (!Number.isFinite(until) || until <= 0)) throw new Error("The end date is not a valid time.");

  const model = input.model?.trim() ?? "";
  if (model && !/^[\w./:@*!-]+$/.test(model)) throw new Error("The model pattern contains characters pi does not accept.");

  const parsed = parseSchedule(input.schedule, now);
  return {
    title,
    prompt,
    schedule: parsed.canonical,
    cwd,
    until,
    model: model || null,
    enabled: true,
    catchUp: input.catchUp,
  };
}

/** Inserts or replaces a task and returns it. */
export function upsertTask(store: TaskStore, task: ScheduledTask): ScheduledTask {
  const index = store.tasks.findIndex((entry) => entry.id === task.id);
  if (index === -1) {
    if (store.tasks.length >= MAX_TASKS) throw new Error(`At most ${MAX_TASKS} tasks are supported.`);
    store.tasks.push(task);
  } else {
    store.tasks[index] = task;
  }
  return task;
}

export function removeTask(store: TaskStore, id: string): boolean {
  const index = store.tasks.findIndex((task) => task.id === id);
  if (index === -1) return false;
  store.tasks.splice(index, 1);
  return true;
}

export function findTask(store: TaskStore, id: string): ScheduledTask | undefined {
  const wanted = id.trim().replace(/^#/, "");
  return store.tasks.find((task) => task.id === wanted);
}
