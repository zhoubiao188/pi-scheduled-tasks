import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSessionFile, resolvePiCommand, runPiPrompt } from "../src/runner.ts";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduled-tasks-run-"));
}

/** A stand-in for the pi CLI that speaks the JSON event protocol. */
function fakePi(dir, body) {
  const file = path.join(dir, "fake-pi.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), "argv.json"), JSON.stringify(argv));
const sessionsRoot = process.env.FAKE_SESSIONS_ROOT;
${body}
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function writeSession(sessionsRoot) {
  const projectDir = path.join(sessionsRoot, "--tmp-project--");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `2026-11-25T00-00-00-000Z_${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, "");
  return file;
}

test("resolvePiCommand honours the override and ignores missing files", () => {
  assert.equal(resolvePiCommand({ PI_SCHEDULED_TASKS_PI_BIN: process.execPath }), process.execPath);
  assert.equal(resolvePiCommand({ PI_SCHEDULED_TASKS_PI_BIN: "/definitely/not/here/pi" }), null);
});

test("findSessionFile locates a session by id anywhere under the root", async () => {
  const root = tempDir();
  const file = writeSession(root);
  assert.equal(await findSessionFile(root, SESSION_ID), file);
  assert.equal(await findSessionFile(root, "not-a-session-id"), undefined);
  assert.equal(await findSessionFile(path.join(root, "missing"), SESSION_ID), undefined);
});

test("a successful run reports ok, the summary and the session file", async () => {
  const dir = tempDir();
  const work = tempDir();
  const sessionsRoot = tempDir();
  const expectedSession = writeSession(sessionsRoot);
  const bin = fakePi(
    dir,
    `
console.log(JSON.stringify({ type: "session", id: ${JSON.stringify(SESSION_ID)} }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }));
console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "All done." }] }] }));
`,
  );

  const prompt = "line one\nline two";
  const outcome = await runPiPrompt({
    prompt,
    cwd: work,
    title: "Demo",
    command: bin,
    sessionsRoot,
    env: { FAKE_SESSIONS_ROOT: sessionsRoot },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary, "All done.");
  assert.equal(outcome.sessionFile, expectedSession);

  const argv = JSON.parse(fs.readFileSync(path.join(work, "argv.json"), "utf8"));
  assert.ok(argv.includes(prompt), "the prompt is a single argv element");
  assert.deepEqual(argv.slice(0, 3), ["--mode", "json", "-p"]);
  assert.ok(argv.includes("--name"));
});

test("the prompt is never mistaken for a flag or a file reference", async () => {
  const dir = tempDir();
  const work = tempDir();
  const sessionsRoot = tempDir();
  const bin = fakePi(dir, `console.log(JSON.stringify({ type: "agent_end", messages: [] }));`);

  await runPiPrompt({
    prompt: "--danger",
    cwd: work,
    title: "Demo",
    command: bin,
    sessionsRoot,
  });
  let argv = JSON.parse(fs.readFileSync(path.join(work, "argv.json"), "utf8"));
  assert.equal(argv.at(-1), "\n--danger");

  await runPiPrompt({
    prompt: "@file.md",
    cwd: work,
    title: "Demo",
    command: bin,
    sessionsRoot,
  });
  argv = JSON.parse(fs.readFileSync(path.join(work, "argv.json"), "utf8"));
  assert.equal(argv.at(-1), "\n@file.md");
});

test("a failing run keeps stderr as the error", async () => {
  const dir = tempDir();
  const work = tempDir();
  const bin = fakePi(dir, `console.error("no credentials"); process.exit(2);`);

  const outcome = await runPiPrompt({
    prompt: "hi",
    cwd: work,
    title: "Demo",
    command: bin,
    sessionsRoot: tempDir(),
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.error, /no credentials/);
});

test("a run that never finishes is terminated and reported", async () => {
  const dir = tempDir();
  const work = tempDir();
  const bin = fakePi(dir, `setTimeout(() => {}, 60_000);`);

  const outcome = await runPiPrompt({
    prompt: "hi",
    cwd: work,
    title: "Demo",
    command: bin,
    sessionsRoot: tempDir(),
    timeoutMs: 150,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Timed out/);
  assert.ok(outcome.durationMs < 10_000);
});

test("a missing executable fails without throwing", async () => {
  const outcome = await runPiPrompt({
    prompt: "hi",
    cwd: tempDir(),
    title: "Demo",
    command: path.join(tempDir(), "missing-pi"),
    sessionsRoot: tempDir(),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
});
