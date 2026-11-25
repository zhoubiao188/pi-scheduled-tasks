/**
 * Runs one task by starting a headless pi process in the task's working
 * directory. A separate process per run gives every run its own context
 * window, its own session file (so it shows up in Pi Web and the CLI like any
 * other session), and keeps a long run from blocking the session that hosts
 * the scheduler.
 *
 * The prompt is passed as a single argv element with `shell: false`, so no
 * part of it is ever interpreted by a shell.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 600;
const KILL_GRACE_MS = 5_000;

export interface RunOptions {
  prompt: string;
  cwd: string;
  title: string;
  timeoutMs?: number;
  /** Absolute path to the pi executable. */
  command: string;
  /** Session root, used to locate the file the run wrote. */
  sessionsRoot: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}

export interface RunOutcome {
  ok: boolean;
  exitCode: number | null;
  summary: string;
  error?: string;
  sessionFile?: string;
  durationMs: number;
}

/** Locates a runnable pi executable without trusting `PATH` order blindly. */
export function resolvePiCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.PI_SCHEDULED_TASKS_PI_BIN?.trim();
  if (override) return fs.existsSync(override) ? override : null;

  const executable = process.platform === "win32" ? "pi.cmd" : "pi";
  const candidates = [
    path.join(path.dirname(process.execPath), executable),
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
    "/usr/bin/pi",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
      ? String((part as { text?: unknown }).text ?? "")
      : ""))
    .join("")
    .trim();
}

function limit(text: string, max = MAX_SUMMARY_LENGTH): string {
  const line = text.replace(/\s+\n/g, "\n").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/** Finds the session file a run wrote, by the session id in its header. */
export async function findSessionFile(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(sessionId)) return undefined;
  let entries: string[];
  try {
    entries = (await fsp.readdir(sessionsRoot, { recursive: true })) as string[];
  } catch {
    return undefined;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.endsWith(suffix));
  return match ? path.join(sessionsRoot, match) : undefined;
}

export async function runPiPrompt(options: RunOptions): Promise<RunOutcome> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // pi's parser has no `--` terminator: a prompt that starts with `-` would
  // be read as a flag and one that starts with `@` as a file reference.
  const prompt = /^[-@]/.test(options.prompt) ? `\n${options.prompt}` : options.prompt;
  const args = ["--mode", "json", "-p", "--name", `⏰ ${limit(options.title, 80)}`, ...(options.extraArgs ?? []), prompt];

  return await new Promise<RunOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options.env, PI_SCHEDULED_TASK_CHILD: "1" },
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, summary: "", error: String(error), durationMs: Date.now() - startedAt });
      return;
    }

    let buffer = "";
    let stdoutBytes = 0;
    let stderr = "";
    let sessionId = "";
    let summary = "";
    let lastAssistant = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      void (async () => {
        const sessionFile = sessionId ? await findSessionFile(options.sessionsRoot, sessionId) : undefined;
        resolve({ ...outcome, summary: limit(summary || lastAssistant), sessionFile, durationMs: Date.now() - startedAt });
      })();
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      finish({
        ok: false,
        exitCode: null,
        summary: "",
        error: `Timed out after ${Math.round(timeoutMs / 60_000)} minutes.`,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "session" && typeof event.id === "string") {
        sessionId = event.id;
        return;
      }
      if (event.type === "message_end" && typeof event.message === "object" && event.message !== null) {
        const message = event.message as { role?: string };
        if (message.role === "assistant") {
          const text = textOf(message);
          if (text) lastAssistant = text;
        }
      }
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        const last = [...event.messages].reverse().find((message) => (message as { role?: string })?.role === "assistant");
        const text = textOf(last);
        if (text) summary = text;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return;
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish({ ok: false, exitCode: null, summary: "", error: error.message, durationMs: Date.now() - startedAt });
    });

    child.on("close", (code) => {
      if (buffer) handleLine(buffer);
      if (code === 0) {
        finish({ ok: true, exitCode: 0, summary: "", durationMs: Date.now() - startedAt });
      } else {
        const reason = stderr.trim() || (code === null ? "Process was terminated." : `pi exited with code ${code}.`);
        finish({ ok: false, exitCode: code, summary: "", error: limit(reason, 400), durationMs: Date.now() - startedAt });
      }
    });
  });
}
