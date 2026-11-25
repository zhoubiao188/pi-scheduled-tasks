# Changelog

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
