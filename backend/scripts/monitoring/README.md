# Monitoring queries

Diagnostic SQL for the notification pipeline and approval state machine. Each file is self-contained — run it directly via `psql`, the Supabase SQL Editor, or `supabase db query --linked`.

These close launch-checklist #15 (monitoring/alerting) at the **query** level. Wiring them into an alert target (PagerDuty, Slack webhook, email digest, Grafana) is a separate decision — the queries emit a `status` column (`ok` / `WARN` / `ALERT` / `BLOCKED`) that any alerting tool can match against.

## Files

| File | What it surfaces | Suggested cadence |
|---|---|---|
| [`cron_health.sql`](cron_health.sql) | pg_cron job health: last success, 24h failure count, staleness vs. expected cadence | every 5 min |
| [`stuck_sending.sql`](stuck_sending.sql) | notification_outbox rows stuck in `sending` — drain crashed mid-delivery | every 5 min |
| [`notification_failures_spike.sql`](notification_failures_spike.sql) | exhausted deliveries in the last 24h, grouped by hour + tenant | every 15 min |
| [`open_runs_aging.sql`](open_runs_aging.sql) | approval runs past tenant stall threshold — operator view, not an alert | on-demand |

## Status keys (consistent across files)

- **ok** — nothing to do
- **WARN** — elevated but not page-worthy (look within the next business day)
- **ALERT** — page-worthy; investigate now
- **BLOCKED** — cutover-blocking; the system is broken, not just slow

## Wiring to alerts

Minimum viable: run each non-on-demand query on a cron (outside the DB — e.g. a GH Actions scheduled workflow, an uptime service, or a plain cronjob on an ops box) and pipe rows with `status` starting in `ALERT` or `BLOCKED` to whatever alert target you use.

A heavier setup (Grafana + pg_exporter or direct PostgREST querying) can render the same queries as live tiles.

## Thresholds

Numeric thresholds in each file are starting guesses — revisit after ~2 weeks of production traffic once a baseline is known. Comments at the top of each file note which knobs are tunable.
