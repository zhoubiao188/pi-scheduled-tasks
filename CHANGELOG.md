# Changelog

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
