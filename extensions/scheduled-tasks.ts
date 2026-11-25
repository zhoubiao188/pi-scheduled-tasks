/**
 * Scheduled tasks for pi and Pi Web.
 *
 * Install the package, then use `/tasks` in any session:
 *
 *   /tasks                 open the task manager
 *   /tasks add             create a task
 *   /tasks list            print the tasks
 *   /tasks run <id>        run a task now
 *   /tasks edit <id>       change name, prompt, schedule or directory
 *   /tasks pause|resume <id>
 *   /tasks rm <id>         delete a task
 *   /tasks open <id>       show the last runs and open one
 *
 * A task sends its prompt to a fresh headless `pi` process in the task's
 * working directory, so every run gets its own context window and its own
 * session file: the run shows up in Pi Web's sidebar like any other session.
 *
 * The prompt is passed as one argv element with `shell: false`. Nothing is
 * ever evaluated by a shell, and no provider or tool configuration is touched.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT_MS, resolvePiCommand, runPiPrompt, type RunOutcome } from "../src/runner.ts";
import {
  describeSchedule,
  formatDateTime,
  formatRelative,
  nextRunAt,
  parseSchedule,
  ScheduleError,
} from "../src/schedule.ts";
import {
  findTask,
  loadStore,
  MAX_HISTORY,
  newTaskId,
  removeTask,
  saveStore,
  upsertTask,
  validateTaskInput,
  type RunRecord,
  type ScheduledTask,
  type TaskStore,
} from "../src/store.ts";

const INSTANCE_KEY = Symbol.for("pi-scheduled-tasks/instance");
const LIVENESS_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const TICK_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const LEADER_STALE_MS = 60_000;
/** A run this late is treated as missed rather than started. */
const MISS_GRACE_MS = 2 * 60 * 1000;
const WIDGET_LINES = 6;

interface LivenessRegistry {
  version: number;
  register(provider: {
    name: string;
    sessionId: string;
    sessionFile?: string;
    isActive(): boolean;
  }): () => void;
}

interface Host {
  ctx: ExtensionContext;
  sessionId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export default function scheduledTasks(pi: ExtensionAPI) {
  const registry = globalThis as Record<PropertyKey, unknown>;
  // Loaded twice (global and project settings) still means one scheduler.
  if (registry[INSTANCE_KEY]) return;
  registry[INSTANCE_KEY] = true;
  // A task's own headless run must never schedule anything.
  if (process.env.PI_SCHEDULED_TASK_CHILD === "1") return;

  // PI_SCHEDULED_TASKS_DIR keeps tests (and isolated setups) out of ~/.pi/agent.
  const agentDir = process.env.PI_SCHEDULED_TASKS_DIR?.trim() || getAgentDir();
  const storeFile = path.join(agentDir, "scheduled-tasks.json");
  const lockFile = path.join(agentDir, "scheduled-tasks.lock");
  const claimsDir = path.join(agentDir, "scheduled-tasks-runs");
  const sessionsRoot = path.join(agentDir, "sessions");
  const timeoutMs = Number(process.env.PI_SCHEDULED_TASKS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  let host: Host | null = null;
  let store: TaskStore = { version: 1, tasks: [] };
  let leaderNonce: string | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let livenessRelease: (() => void) | null = null;
  let ticking = false;
  let running = false;
  let runningTaskId: string | null = null;
  // The same status pushed on every tick is noise in the transcript and in RPC clients.
  let lastStatus: string | null = null;
  let lastWidget: string | null = null;

  // ---------------------------------------------------------------- storage

  async function persist(mutator: (fresh: TaskStore) => void): Promise<TaskStore> {
    let next = store;
    await withFileMutationQueue(storeFile, async () => {
      const fresh = loadStore(storeFile);
      mutator(fresh);
      saveStore(storeFile, fresh);
      next = fresh;
    });
    store = next;
    return store;
  }

  function reload(): void {
    store = loadStore(storeFile);
  }

  // ------------------------------------------------------------- leadership

  async function readLock(): Promise<{ pid: number; sessionId: string; at: number; nonce: string } | null> {
    try {
      const text = await fsp.readFile(lockFile, "utf8");
      const data = JSON.parse(text) as Record<string, unknown>;
      if (typeof data.sessionId !== "string") return null;
      return {
        pid: Number(data.pid) || 0,
        sessionId: data.sessionId,
        at: Number(data.at) || 0,
        nonce: typeof data.nonce === "string" ? data.nonce : "",
      };
    } catch {
      return null;
    }
  }

  async function ensureLeadership(): Promise<boolean> {
    if (!host) return false;
    if (leaderNonce) return true;

    const nonce = randomUUID();
    const payload = { pid: process.pid, sessionId: host.sessionId, at: Date.now(), nonce };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fsp.open(lockFile, "wx", 0o600);
        await handle.writeFile(JSON.stringify(payload));
        await handle.close();
        leaderNonce = nonce;
        refreshUi();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        const current = await readLock();
        if (current && Date.now() - current.at < LEADER_STALE_MS) return false;
        await fsp.rm(lockFile, { force: true });
      }
    }
    return false;
  }

  async function releaseLeadership(): Promise<void> {
    if (!leaderNonce) return;
    const current = await readLock();
    if (current?.nonce === leaderNonce) await fsp.rm(lockFile, { force: true });
    leaderNonce = null;
    syncLiveness();
  }

  function startHeartbeat(): void {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      if (!leaderNonce || !host) return;
      const payload = { pid: process.pid, sessionId: host.sessionId, at: Date.now(), nonce: leaderNonce };
      void fsp.writeFile(lockFile, JSON.stringify(payload), { mode: 0o600 }).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  // --------------------------------------------------------- occurrence dedupe

  async function claim(taskId: string, scheduledFor: number): Promise<boolean> {
    try {
      await fsp.mkdir(claimsDir, { recursive: true, mode: 0o700 });
      const handle = await fsp.open(path.join(claimsDir, `${taskId}-${scheduledFor}.lock`), "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      // A claims directory we cannot write must not stop the run.
      return true;
    }
  }

  async function pruneClaims(): Promise<void> {
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const files = await fsp.readdir(claimsDir);
      for (const file of files) {
        const full = path.join(claimsDir, file);
        const stat = await fsp.stat(full).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fsp.rm(full, { force: true });
      }
    } catch {
      // Nothing to prune.
    }
  }

  // ------------------------------------------------------------------- UI

  function enabledTasks(): ScheduledTask[] {
    return store.tasks.filter((task) => task.enabled);
  }

  function nextRunLabel(): string {
    const next = enabledTasks()
      .map((task) => task.nextRunAt)
      .filter((value): value is number => typeof value === "number");
    if (next.length === 0) return "";
    return formatRelative(Math.min(...next));
  }

  function refreshUi(): void {
    if (!host) return;
    try {
      const { ctx } = host;
      const active = enabledTasks();
      if (active.length === 0) {
        if (lastStatus !== null) {
          ctx.ui.setStatus("command:/tasks", undefined);
          lastStatus = null;
        }
        if (lastWidget !== null) {
          ctx.ui.setWidget("scheduled-tasks", undefined);
          lastWidget = null;
        }
        return;
      }
      const next = nextRunLabel();
      const label = runningTaskId
        ? `⏰ ${active.length} task${active.length === 1 ? "" : "s"} · running`
        : `⏰ ${active.length} active${next ? ` · next ${next}` : ""}`;
      // The `command:` prefix makes this a button in Pi Web that opens /tasks.
      if (label !== lastStatus) {
        ctx.ui.setStatus("command:/tasks", label);
        lastStatus = label;
      }

      const lines = active
        .slice()
        .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
        .slice(0, WIDGET_LINES)
        .map((task) => {
          const mark = runningTaskId === task.id ? "▶" : "●";
          const when = task.nextRunAt ? ` · ${formatDateTime(task.nextRunAt)}` : "";
          return `${mark} ${task.id} ${truncate(task.title, 42)} — ${describeSchedule(task.schedule)}${when}`;
        });
      const hidden = active.length - lines.length;
      if (hidden > 0) lines.push(`+${hidden} more · /tasks`);
      const widget = lines.join("\n");
      if (widget !== lastWidget) {
        ctx.ui.setWidget("scheduled-tasks", lines, { placement: "aboveEditor" });
        lastWidget = widget;
      }
    } catch {
      // A closed or replaced session must not break a run.
    }
  }

  // -------------------------------------------------------------- execution

  async function appendHistory(taskId: string, entry: RunRecord): Promise<void> {
    await persist((fresh) => {
      const current = fresh.tasks.find((task) => task.id === taskId);
      if (!current) return;
      current.history = [entry, ...current.history].slice(0, MAX_HISTORY);
      current.runs += 1;
      current.updatedAt = Date.now();
    });
  }

  function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      host?.ctx.ui.notify(message, type);
    } catch {
      // Notification is best effort.
    }
  }

  function summaryLine(task: ScheduledTask, record: RunRecord, outcome?: RunOutcome): string {
    const icon = record.status === "ok" ? "✅" : record.status === "dispatched" ? "📨" : "❌";
    const seconds = record.durationMs ? `${Math.round(record.durationMs / 1000)}s` : "";
    const tail = record.error ?? (record.summary ? truncate(record.summary, 80) : "");
    const session = outcome?.sessionFile ? ` · ${path.basename(outcome.sessionFile)}` : "";
    return `${icon} ${task.title}${seconds ? ` · ${seconds}` : ""}${tail ? ` · ${tail}` : ""}${session}`;
  }

  /**
   * Runs one task. `scheduledFor` is the occurrence this run belongs to; for a
   * manual run it is the current time and the schedule is left untouched.
   */
  async function fire(task: ScheduledTask, scheduledFor: number, manual = false): Promise<void> {
    if (running) return;
    running = true;
    runningTaskId = task.id;
    refreshUi();

    const startedAt = Date.now();
    let outcome: RunOutcome | undefined;
    let record: RunRecord;

    try {
      if (!manual) {
        // Advance the schedule first: a crash mid-run must not re-fire it.
        await persist((fresh) => {
          const current = fresh.tasks.find((entry) => entry.id === task.id);
          if (!current) return;
          const next = nextRunAt(current.schedule, Math.max(startedAt, scheduledFor));
          current.nextRunAt = next;
          if (next === null) current.enabled = false;
          current.updatedAt = startedAt;
        });
        const current = store.tasks.find((entry) => entry.id === task.id);
        if (current) task = current;
      }

      const command = resolvePiCommand();
      if (!command) {
        // Without a pi executable the prompt still goes out, in this session.
        const ctx = host?.ctx;
        if (!ctx) throw new Error("No session available to deliver the prompt.");
        if (ctx.isIdle()) pi.sendUserMessage(task.prompt);
        else pi.sendUserMessage(task.prompt, { deliverAs: "followUp" });
        record = {
          at: startedAt,
          status: "dispatched",
          summary: "Sent into this session: no pi executable was found for a separate run.",
        };
      } else {
        outcome = await runPiPrompt({
          prompt: task.prompt,
          cwd: task.cwd,
          title: task.title,
          timeoutMs,
          command,
          sessionsRoot,
        });
        record = {
          at: startedAt,
          status: outcome.ok ? "ok" : "error",
          durationMs: outcome.durationMs,
          ...(outcome.summary ? { summary: outcome.summary } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
        };
      }
    } catch (error) {
      record = { at: startedAt, status: "error", durationMs: Date.now() - startedAt, error: errorText(error) };
    } finally {
      running = false;
      runningTaskId = null;
    }

    await appendHistory(task.id, record);
    notify(summaryLine(task, record, outcome), record.status === "ok" || record.status === "dispatched" ? "info" : "error");
    refreshUi();
  }

  async function markMissed(task: ScheduledTask, now: number): Promise<void> {
    await persist((fresh) => {
      const current = fresh.tasks.find((entry) => entry.id === task.id);
      if (!current) return;
      const missed: RunRecord = {
        at: now,
        status: "missed",
        summary: `Scheduled for ${formatDateTime(task.nextRunAt ?? now)}, found after pi was not running.`,
      };
      current.history = [
        missed,
        ...current.history,
      ].slice(0, MAX_HISTORY);
      current.runs += 1;
      const next = nextRunAt(current.schedule, now);
      current.nextRunAt = next;
      if (next === null) current.enabled = false;
      current.updatedAt = now;
    });
    notify(`⏭ ${task.title} · missed ${formatDateTime(task.nextRunAt ?? now)}`, "warning");
    refreshUi();
  }

  async function processDue(now: number): Promise<void> {
    for (const task of store.tasks) {
      if (!task.enabled) continue;
      if (task.nextRunAt === null) {
        const next = nextRunAt(task.schedule, now);
        await persist((fresh) => {
          const current = fresh.tasks.find((entry) => entry.id === task.id);
          if (!current || current.nextRunAt !== null) return;
          current.nextRunAt = next;
          if (next === null) current.enabled = false;
        });
        if (next === null) notify(`Task "${task.title}" has no future run and was paused.`, "warning");
        continue;
      }
      if (task.nextRunAt > now) continue;

      const late = now - task.nextRunAt;
      const due = task.nextRunAt;
      if (late > MISS_GRACE_MS && !task.catchUp) {
        await markMissed(task, now);
        return;
      }
      if (!(await claim(task.id, due))) continue;
      await fire(task, due);
      return; // one run at a time
    }
  }

  async function tick(): Promise<void> {
    if (ticking || !host) return;
    ticking = true;
    try {
      reload();
      if (!leaderNonce) {
        const leader = await ensureLeadership();
        if (leader) {
          startHeartbeat();
          syncLiveness();
        }
      }
      if (!leaderNonce) {
        refreshUi();
        return;
      }
      syncLiveness();
      await processDue(Date.now());
      void pruneClaims();
    } catch (error) {
      // The next tick retries; a failing task must not stop the scheduler.
      notify(`Scheduler error: ${errorText(error)}`, "error");
    } finally {
      ticking = false;
      refreshUi();
    }
  }

  // -------------------------------------------------------------- liveness

  function syncLiveness(): void {
    const wanted = Boolean(leaderNonce && host && store.tasks.some((task) => task.enabled));
    if (wanted && !livenessRelease) {
      const runtime = (globalThis as Record<PropertyKey, unknown>)[LIVENESS_KEY] as LivenessRegistry | undefined;
      if (runtime?.version !== 1 || typeof runtime.register !== "function" || !host) return;
      const sessionFile = host.ctx.sessionManager.getSessionFile?.();
      try {
        livenessRelease = runtime.register({
          name: "scheduled-tasks",
          sessionId: host.sessionId,
          ...(sessionFile ? { sessionFile } : {}),
          // Pi Web keeps this session loaded so a timer can still fire with no tab open.
          isActive: () => Boolean(leaderNonce) && store.tasks.some((task) => task.enabled),
        });
      } catch {
        livenessRelease = null;
      }
    } else if (!wanted && livenessRelease) {
      livenessRelease();
      livenessRelease = null;
    }
  }

  // --------------------------------------------------------------- session

  pi.on("session_start", async (_event, ctx) => {
    host = { ctx, sessionId: ctx.sessionManager.getSessionId() };
    lastStatus = null;
    lastWidget = null;
    reload();
    refreshUi();
    await ensureLeadership();
    startHeartbeat();
    syncLiveness();
    refreshUi();
    if (leaderNonce) void tick();
    if (!ticker) {
      ticker = setInterval(() => void tick(), TICK_MS);
      ticker.unref?.();
    }
  });

  pi.on("session_shutdown", async () => {
    if (ticker) clearInterval(ticker);
    if (heartbeat) clearInterval(heartbeat);
    ticker = null;
    heartbeat = null;
    if (livenessRelease) livenessRelease();
    livenessRelease = null;
    await releaseLeadership();
    host = null;
  });

  // ------------------------------------------------------------------ forms

  async function askCatchUp(ctx: ExtensionCommandContext): Promise<boolean | null> {
    const options = [
      "Skip runs missed while pi was closed",
      "Run once when a session opens",
    ];
    const answer = await ctx.ui.select("If a run is missed, what should happen?", options);
    if (answer === undefined) return null;
    return answer === options[1];
  }

  async function askCwd(ctx: ExtensionCommandContext, current: string): Promise<string | null> {
    const answer = await ctx.ui.input("Working directory", current);
    if (answer === undefined) return null;
    const cwd = path.resolve(answer.trim() || current);
    try {
      const stat = await fsp.stat(cwd);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      ctx.ui.notify(`Not a directory: ${cwd}`, "error");
      return null;
    }
    return cwd;
  }

  async function createTask(ctx: ExtensionCommandContext): Promise<void> {
    const title = await ctx.ui.input("Task name", "Morning inbox cleanup");
    if (title === undefined || !title.trim()) return;

    const prompt = await ctx.ui.editor("Prompt sent on every run", "");
    if (prompt === undefined || !prompt.trim()) return;

    const schedule = await ctx.ui.input(
      'Schedule — cron "0 9 * * *", "every 30m", or "at 2026-11-26T09:00"',
      "0 9 * * *",
    );
    if (schedule === undefined || !schedule.trim()) return;

    let parsed;
    try {
      parsed = parseSchedule(schedule);
    } catch (error) {
      ctx.ui.notify(error instanceof ScheduleError ? error.message : errorText(error), "error");
      return;
    }
    const firstRun = nextRunAt(parsed.schedule, Date.now());
    if (firstRun === null) {
      ctx.ui.notify("That time is already in the past.", "error");
      return;
    }

    const cwd = await askCwd(ctx, ctx.cwd);
    if (cwd === null) return;

    const catchUp = await askCatchUp(ctx);
    if (catchUp === null) return;

    const now = Date.now();
    try {
      const fields = validateTaskInput({ title, prompt, schedule: parsed.canonical, cwd, catchUp }, now);
      let id = newTaskId();
      while (store.tasks.some((entry) => entry.id === id)) id = newTaskId();
      const task: ScheduledTask = {
        id,
        ...fields,
        createdAt: now,
        updatedAt: now,
        nextRunAt: firstRun,
        runs: 0,
        history: [],
      };
      await persist((fresh) => {
        upsertTask(fresh, task);
      });
      ctx.ui.notify(
        `Created #${task.id} · ${task.title} · ${describeSchedule(task.schedule)} · first run ${formatRelative(firstRun)}`,
        "info",
      );
      refreshUi();
    } catch (error) {
      ctx.ui.notify(errorText(error), "error");
    }
  }

  async function editTask(ctx: ExtensionCommandContext, task: ScheduledTask): Promise<void> {
    const title = await ctx.ui.input(`Name — currently "${task.title}" (empty keeps it)`, task.title);
    if (title === undefined) return;

    const prompt = await ctx.ui.editor("Prompt sent on every run (empty keeps it)", task.prompt);
    if (prompt === undefined) return;

    const schedule = await ctx.ui.input(`Schedule — currently "${task.schedule}" (empty keeps it)`, task.schedule);
    if (schedule === undefined) return;

    const cwd = await askCwd(ctx, task.cwd);
    if (cwd === null) return;

    const catchUp = await askCatchUp(ctx);
    if (catchUp === null) return;

    const nextSchedule = schedule.trim() || task.schedule;
    const now = Date.now();
    try {
      const fields = validateTaskInput(
        {
          title: title.trim() || task.title,
          prompt: prompt.trim() || task.prompt,
          schedule: nextSchedule,
          cwd,
          catchUp,
        },
        now,
      );
      const next = nextRunAt(fields.schedule, now);
      await persist((fresh) => {
        const current = fresh.tasks.find((entry) => entry.id === task.id);
        if (!current) return;
        Object.assign(current, fields, {
          updatedAt: now,
          nextRunAt: next,
          enabled: next === null ? false : current.enabled,
        });
      });
      ctx.ui.notify(
        next === null
          ? `Saved #${task.id}; it has no future run and stays paused.`
          : `Saved #${task.id} · next run ${formatRelative(next)}`,
        "info",
      );
      refreshUi();
    } catch (error) {
      ctx.ui.notify(errorText(error), "error");
    }
  }

  async function toggleTask(ctx: ExtensionCommandContext, task: ScheduledTask): Promise<void> {
    const next = task.enabled ? null : nextRunAt(task.schedule, Date.now());
    if (!task.enabled && next === null) {
      ctx.ui.notify("This task has no future run; edit its schedule first.", "warning");
      return;
    }
    await persist((fresh) => {
      const current = fresh.tasks.find((entry) => entry.id === task.id);
      if (!current) return;
      current.enabled = !task.enabled;
      current.nextRunAt = current.enabled ? next : null;
      current.updatedAt = Date.now();
    });
    ctx.ui.notify(`${task.enabled ? "Paused" : "Resumed"} #${task.id} ${task.title}`, "info");
    refreshUi();
  }

  async function deleteTask(ctx: ExtensionCommandContext, task: ScheduledTask): Promise<void> {
    const confirmed = await ctx.ui.confirm(`Delete "${task.title}"?`, "The task and its run history are removed.");
    if (!confirmed) return;
    await persist((fresh) => {
      removeTask(fresh, task.id);
    });
    ctx.ui.notify(`Deleted #${task.id} ${task.title}`, "info");
    refreshUi();
  }

  async function showRuns(ctx: ExtensionCommandContext, task: ScheduledTask): Promise<void> {
    if (task.history.length === 0) {
      ctx.ui.notify(`#${task.id} has not run yet.`, "info");
      return;
    }
    const labels = task.history.map((run, index) => {
      const icon = run.status === "ok" ? "✅" : run.status === "dispatched" ? "📨" : run.status === "missed" ? "⏭" : "❌";
      const detail = run.error ?? run.summary ?? "";
      return `${index + 1}. ${icon} ${formatDateTime(run.at)} · ${run.status}${detail ? ` · ${truncate(detail, 70)}` : ""}`;
    });
    const choice = await ctx.ui.select(`Runs of "${task.title}" — pick one to open its session`, labels);
    if (choice === undefined) return;
    const run = task.history[labels.indexOf(choice)];
    if (!run?.sessionFile) {
      ctx.ui.notify("That run has no saved session.", "warning");
      return;
    }
    try {
      await ctx.switchSession(run.sessionFile);
    } catch (error) {
      ctx.ui.notify(`Could not open the session: ${errorText(error)}`, "error");
    }
  }

  async function manageTask(ctx: ExtensionCommandContext, task: ScheduledTask): Promise<void> {
    const actions = [
      "Run now",
      "Edit",
      task.enabled ? "Pause" : "Resume",
      "Runs",
      "Delete",
      "Back",
    ];
    const action = await ctx.ui.select(
      `${task.title}\n${describeSchedule(task.schedule)} · ${task.enabled ? "active" : "paused"}${
        task.nextRunAt ? ` · next ${formatRelative(task.nextRunAt)}` : ""
      }`,
      actions,
    );
    if (action === undefined || action === "Back") return;

    if (action === "Run now") {
      if (running) {
        ctx.ui.notify("A task is already running. Try again when it finishes.", "warning");
        return;
      }
      await fire(task, Date.now(), true);
      return;
    }
    if (action === "Edit") return editTask(ctx, task);
    if (action === "Pause" || action === "Resume") return toggleTask(ctx, task);
    if (action === "Runs") return showRuns(ctx, task);
    if (action === "Delete") return deleteTask(ctx, task);
  }

  async function openManager(ctx: ExtensionCommandContext): Promise<void> {
    for (;;) {
      reload();
      const tasks = store.tasks.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled));
      if (tasks.length === 0) {
        const start = await ctx.ui.confirm(
          "No scheduled tasks",
          "Create one? It sends a prompt on a schedule, in this project or another directory.",
        );
        if (!start) return;
        await createTask(ctx);
        continue;
      }

      const newLabel = "＋ New task";
      const labels = tasks.map((task) => {
        const state = runningTaskId === task.id ? "▶ running" : task.enabled ? "●" : "○ paused";
        const next = task.enabled && task.nextRunAt ? ` · next ${formatRelative(task.nextRunAt)}` : "";
        return `${task.id}  ${state}  ${truncate(task.title, 40)} — ${describeSchedule(task.schedule)}${next}`;
      });
      const choice = await ctx.ui.select(
        `Scheduled tasks · ${enabledTasks().length} active · ${tasks.length} total`,
        [newLabel, ...labels, "Close"],
      );
      if (choice === undefined || choice === "Close") return;
      if (choice === newLabel) {
        await createTask(ctx);
        continue;
      }
      const task = tasks[labels.indexOf(choice)];
      if (task) await manageTask(ctx, task);
    }
  }

  // ---------------------------------------------------------------- commands

  pi.registerCommand("tasks", {
    description: "Scheduled tasks: /tasks opens the manager · add · list · run · edit · pause · resume · rm",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "add", label: "add", description: "Create a scheduled task" },
        { value: "list", label: "list", description: "Print the tasks" },
        ...store.tasks.flatMap((task) => [
          { value: `run ${task.id}`, label: `run ${task.id}`, description: `${task.title} — run now` },
          { value: `edit ${task.id}`, label: `edit ${task.id}`, description: `${task.title} — edit` },
          { value: `rm ${task.id}`, label: `rm ${task.id}`, description: `${task.title} — delete` },
        ]),
      ];
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      reload();
      const input = args.trim();
      const [head, ...rest] = input.split(/\s+/);
      const argument = rest.join(" ").trim();

      if (!input) return openManager(ctx);
      if (head === "add" || head === "new") return createTask(ctx);

      if (head === "list") {
        if (store.tasks.length === 0) {
          ctx.ui.notify("No scheduled tasks. /tasks add", "info");
          return;
        }
        const lines = store.tasks
          .slice()
          .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
          .map((task) => {
            const state = task.enabled ? (task.nextRunAt ? formatDateTime(task.nextRunAt) : "paused") : "paused";
            return `#${task.id}  ${state}  ${task.title} — ${describeSchedule(task.schedule)}`;
          });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const task = findTask(store, argument);
      if (!task) {
        ctx.ui.notify(argument ? `No task #${argument}. /tasks list` : "Pick a task id: /tasks run <id>", "warning");
        return;
      }

      switch (head) {
        case "run":
          if (running) return ctx.ui.notify("A task is already running.", "warning");
          return fire(task, Date.now(), true);
        case "edit":
          return editTask(ctx, task);
        case "pause":
          if (!task.enabled) return ctx.ui.notify(`#${task.id} is already paused.`, "info");
          return toggleTask(ctx, task);
        case "resume":
          if (task.enabled) return ctx.ui.notify(`#${task.id} is already active.`, "info");
          return toggleTask(ctx, task);
        case "rm":
        case "delete":
          return deleteTask(ctx, task);
        case "runs":
        case "history":
        case "open":
          return showRuns(ctx, task);
        case "show":
          ctx.ui.notify(
            `#${task.id} ${task.title}\n${task.prompt}\n${describeSchedule(task.schedule)} · ${task.cwd}\n${
              task.nextRunAt ? `next ${formatDateTime(task.nextRunAt)}` : "no future run"
            } · ${task.runs} run${task.runs === 1 ? "" : "s"}`,
            "info",
          );
          return;
        default:
          ctx.ui.notify(`Unknown subcommand "${head}". Try /tasks`, "warning");
      }
    },
  });

  // A quick way to create one without opening the manager.
  pi.registerCommand("at", {
    description: 'One-off task: /at 09:00 <prompt> · /at 2026-11-26T09:00 <prompt>',
    handler: async (args, ctx) => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      if (!match) {
        ctx.ui.notify("Usage: /at 09:00 <prompt>", "warning");
        return;
      }
      try {
        reload();
        const parsed = parseSchedule(`at ${match[1]}`, Date.now());
        const next = nextRunAt(parsed.schedule, Date.now());
        if (next === null) {
          ctx.ui.notify("That time is already in the past.", "error");
          return;
        }
        const now = Date.now();
        const fields = validateTaskInput(
          {
            title: truncate(match[2], 60),
            prompt: match[2],
            schedule: parsed.canonical,
            cwd: path.resolve(ctx.cwd),
            catchUp: false,
          },
          now,
        );
        const task: ScheduledTask = {
          id: newTaskId(),
          ...fields,
          createdAt: now,
          updatedAt: now,
          nextRunAt: next,
          runs: 0,
          history: [],
        };
        await persist((fresh) => {
          upsertTask(fresh, task);
        });
        ctx.ui.notify(`Scheduled #${task.id} for ${formatDateTime(next)}`, "info");
        refreshUi();
      } catch (error) {
        ctx.ui.notify(error instanceof ScheduleError ? error.message : errorText(error), "error");
      }
    },
  });
}
