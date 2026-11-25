# pi-scheduled-tasks

Scheduled tasks for [pi](https://github.com/earendil-works/pi) and
[Pi Web](https://github.com/agegr/pi-web): cron expressions, intervals and
one-off prompts, managed from a dialog-driven interface inside the session.

Every run is a normal `pi` session in the task's working directory, so it shows
up in Pi Web's sidebar with its own transcript, tools and cost — and the same
tasks work in the terminal.

```
/tasks
```

```
Scheduled tasks · 2 active · 2 total
  a1b2  ●  Morning inbox — cron 0 9 * * * · next in 3h
  c3d4  ●  Deploy check  — every 30m        · next in 12m
  ＋ New task
  Close
```

## Why an extension

Pi Web keeps its scope deliberately small. Its contribution guide lists
schedulers and "scheduled messages" as out of scope, and points at an extension
for exactly this use case:

- [CONTRIBUTING.md — Out of scope](https://github.com/agegr/pi-web/blob/main/CONTRIBUTING.md#out-of-scope)
- [Issue #666](https://github.com/agegr/pi-web/issues/666) — closed with a
  `/schedule` extension as the answer
- [PR #1409](https://github.com/agegr/pi-web/pull/1409) — a scheduler in the
  core was declined: "a scheduler is outside what pi-web is meant to be […] A pi
  extension gives the same thing to the CLI as well."

So this is a pi package, not a Pi Web change. It uses only the documented
extension API and Pi Web's documented
[liveness registry](https://github.com/agegr/pi-web/blob/main/docs/integrations.md#extension-session-liveness),
and it behaves the same in the CLI and in Pi Web.

## Related work

`pi-scheduled-tasks` on npm (by errfld) also schedules prompts: it runs them
inside the current session and adds model-callable tools. This package does one
thing differently: every run is a separate session in the task's directory, and
the manager, status bar and run history are built for the browser. If you only
need reminders in the session you already have open, that package may be enough.

## Install

```bash
pi install git:github.com/zhoubiao188/pi-scheduled-tasks
```

Or try it without installing:

```bash
pi -e git:github.com/zhoubiao188/pi-scheduled-tasks
```

Restart Pi Web after installing, or run `/reload` in a session. In Pi Web the
composer completes `/tasks` like any other slash command.

Requirements: pi 0.84 or newer; Pi Web 0.9.0 or newer for the status-bar button and
the liveness registry. Older Pi Web versions still work, but an idle session may
be evicted, so runs wait until a session is open again. No runtime dependencies.

## Use

`/tasks` opens the manager. Select a task to run it now, edit it, pause or
resume it, see its runs, or delete it.

| Command | What it does |
| --- | --- |
| `/tasks` | Open the manager |
| `/tasks add` | Create a task (name, prompt, schedule, directory) |
| `/tasks list` | Print every task and its next run |
| `/tasks run <id>` | Run a task now, without changing its schedule |
| `/tasks edit <id>` | Change name, prompt, schedule or directory |
| `/tasks pause <id>` / `resume <id>` | Stop or restart the schedule |
| `/tasks runs <id>` | Last runs; pick one to open its session |
| `/tasks rm <id>` | Delete the task and its history |
| `/tasks show <id>` | Print one task in full |
| `/at 09:00 <prompt>` | Quick one-off task in the current directory |

### Schedules

| Form | Example | Meaning |
| --- | --- | --- |
| Cron | `0 9 * * *` | 09:00 every day, local time |
| Cron | `*/15 * * * *` | Every 15 minutes |
| Cron | `0 9 * * mon-fri` | Weekdays at 09:00 |
| Cron | `@daily`, `@hourly`, `@weekly`, `@monthly` | Macros |
| Interval | `every 30m`, `1h30m`, `every 2d` | At least one minute |
| Once | `at 09:00`, `at 2026-11-26T09:00` | One run, then the task pauses |

Cron follows the usual rules: five fields, lists, ranges, steps, month and
weekday names, and day-of-month/day-of-week as either/or when both are
restricted.

### What a run looks like

A run starts a headless `pi` in the task's directory:

```
pi --mode json -p --name "⏰ Morning inbox" "<prompt>"
```

The session is saved like any other, so it appears in Pi Web under that
project, and **Runs** opens it directly. The task's history keeps the exit
status, duration, a short summary and the session file (last 20 runs).

### In the Pi Web UI

- A status-bar button shows `⏰ 2 active · next in 12m`; clicking it opens
  `/tasks`.
- A widget above the composer lists the next runs.
- Create and edit use Pi Web's own dialogs, so they work on a phone too.

## Missed runs

Timers live in a pi session. While Pi Web is running, the session that owns the
scheduler is kept loaded for as long as it has active tasks (the documented
liveness registry), even with no browser tab open.

After a restart nothing fires until a session is open again. Each task then
follows its **catch-up** choice:

- **Skip** (default): the missed occurrence is recorded as `missed`, never sent
  late, and the schedule moves on.
- **Run once**: the task runs once when the session opens, then continues on
  schedule. There is never a burst of catch-up runs.

Only one session runs tasks at a time (a lock file), so two open sessions or two
Pi Web tabs cannot double-fire. A per-occurrence claim makes a duplicate across
processes a no-op as well.

## Safety and resource limits

- **No shell.** The prompt is one argv element with `shell: false`; nothing in a
  task is ever interpreted by a shell, and no command line is built from it.
- **No new privileges.** A run is an ordinary pi session: same auth, same
  extensions, same tool permissions, same project trust rules.
- **Bounded.** 50 tasks, 20,000 characters per prompt, 120 per name, 20 history
  entries, one run at a time, 30 minutes per run (SIGTERM, then SIGKILL).
- **Private state.** `~/.pi/agent/scheduled-tasks.json` is written atomically
  with mode `0600` in a `0700` directory. An unreadable file is moved aside,
  never deleted.
- **No recursion.** A task's own pi process gets `PI_SCHEDULED_TASK_CHILD=1` and
  the extension disables itself there.
- **Offline.** The extension makes no network calls and sends no telemetry.
- **No hidden writes.** It only touches its own store, lock, claim files, and
  the session files pi writes for each run.

Tasks are stored in the clear so you can read and back them up. Do not put
secrets in a prompt; use the provider configuration pi already has.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_SCHEDULED_TASKS_PI_BIN` | `pi` next to the running Node | The executable used for a run |
| `PI_SCHEDULED_TASKS_TIMEOUT_MS` | `1800000` | Per-run timeout |
| `PI_SCHEDULED_TASKS_DIR` | `~/.pi/agent` | Store location (tests, isolated setups) |

If no `pi` executable can be found, `/tasks run` still works: the prompt is
delivered into the current session instead of a separate run.

## Known limits

- Times are the local time of the machine running pi. Cron uses the JavaScript
  `Date` rules, so a run at 02:30 on a DST transition can be skipped or repeat.
- A task runs in a fresh session each time; it does not continue the previous
  run's context. Put the context in the prompt, or keep state in files in the
  task's directory.
- Nothing fires while no pi process has the session loaded. Use the catch-up
  option if that matters, or keep a small session open.

## Development

```bash
npm install
npm test          # 35 tests: schedule math, store, runner, extension wiring
npm run typecheck
```

`test/extension.test.mjs` drives the real command handlers with a fake pi API
and fake dialogs; `test/runner.test.mjs` runs a stand-in `pi` that speaks the
JSON event protocol.

## License

MIT. Not affiliated with the pi or Pi Web maintainers.
