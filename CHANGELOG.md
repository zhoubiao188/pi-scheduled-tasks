# Changelog

## 0.3.0

- repeat rules are picked, not typed: hour and minute dropdowns, multi-select
  weekdays and days of the month, month/day dropdowns for a yearly rule
- editing a task opens the same pickers, marked with the current choice, so no
  cron string is ever shown in the editor
- the manager and widget describe a rule in words ("every weekday at 09:00",
  "every month on days 1, 15 at 08:05"); raw cron only for custom expressions

## 0.2.4

- fix: Pi Web runs every session in one process, so a process-wide "already
  loaded" flag left every session after the first without `/tasks`. Each
  session now gets its own instance; the leader lock and per-occurrence claims
  still keep one run per task.

## 0.2.3

- a fresh install is visible: with no tasks the status entry reads
  `⏰ No tasks · /tasks` and the widget above the composer points at `/tasks`
- the widget lists paused tasks too, not only the active ones
- README: where to find the manager (Pi Web has no sidebar page for extensions)

## 0.2.2

- the interval step accepts "every 30m" as well as "30m"
- releases publish from GitHub Actions through npm Trusted Publishing

## 0.2.1

Same code as 0.2.0. The 0.2.0 tarball was staged on npm but the staged
approval endpoint rejected every request, and a direct publish cannot overwrite
a staged version, so this is npm's first published version.

## 0.2.0

Built against the automation guide WorkBuddy publishes, for the parts a local pi
client can do.

- the create flow asks for a repeat rule (daily / weekly / monthly / yearly /
  interval / once / custom cron) instead of raw cron text
- templates for a daily briefing, a weekly report, an inbox cleanup and a CI check
- optional end date and optional per-task `--model`
- `/tasks runs` shows every task's runs on one timeline
- `scheduled_task` tool: the agent can create and list tasks from a sentence
- failed tasks are marked in the manager and the widget

## 0.1.0

## 0.1.0

First release.

- `/tasks` manager: create, edit, pause, resume, run now, runs, delete
- `/at <time> <prompt>` for a quick one-off task
- cron (`0 9 * * mon-fri`, macros), intervals (`every 30m`) and one-off (`at 09:00`) schedules
- every run is its own headless pi session in the task's directory, visible in Pi Web
- skipped or one-shot catch-up for runs missed while pi was closed
- one leader session plus per-occurrence claims, so open tabs cannot double-fire
- status-bar entry, upcoming-runs widget, and Pi Web dialogs for every form
- bounded prompts, history, task count and run time; atomic `0600` store; no shell; no dependencies
