# JobFlow Worker

Cloud brain for JobFlow: Claude API proxy, job crawler on a 30-minute cron,
AI match scoring, and Telegram notifications. Runs on Cloudflare Workers (**Paid plan required**:
one crawl needs ~150–250 ms CPU; the Free plan allows 10 ms).

## Architecture

```
cron (30 min) → crawl 2 sources → dedupe (KV seen-v1) → Supabase jobs (+ Sheet, transitional)
             → queue new jobs (KV pending-v1) → score from the queue (Claude Haiku vs RESUME_SUMMARY)
             → scored ≥ SCORE_THRESHOLD (70) → Telegram, one message per job
extension submit → POST /api/application → Supabase applications (+ Sheet)
extension generate → POST /api/generate → Claude (key lives server-side only)
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/generate` | Bearer | Claude proxy; `{ prompt, stream? }` → text or SSE |
| POST | `/api/application` | Bearer | record a submitted application (idempotent per URL/day) |
| POST | `/api/crawl` | Bearer | trigger one crawl manually |
| POST | `/api/backfill` | Bearer | one-time: load all open jobs into Supabase |
| GET | `/api/status` | Bearer | health stats (runs/added/scored/notified today), config, queue sizes |
| POST | `/api/test-telegram` | Bearer | send a test message; `?sample=1` sends a fake match labelled TEST |
| POST | `/api/test-score` | Bearer | exactly one scoring call on a fixed sample job (billable, ~$0.001); returns the score or the error cause (`auth`, `credit`, `rate_limit`, …) |
| GET | `/api/summary` | Bearer | popup dashboard data |

## Setup

```bash
npx wrangler@latest login
npx wrangler kv namespace create SEEN     # paste the id into wrangler.toml
npx wrangler deploy
```

Secrets (`npx wrangler secret put <NAME>`; multi-line values via heredoc pipe):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `WORKER_TOKEN` | random string (`openssl rand -hex 24`); extension sends it as Bearer |
| `TG_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TG_CHAT_ID` | your chat id (`getUpdates` after messaging the bot) |
| `SHEET_WEBHOOK_URL` | Apps Script `/exec` URL (transitional Sheet dual-write) |
| `SUPABASE_URL` | project URL (`https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | service_role key — server-side only |
| `RESUME_SUMMARY` | candidate background summary used for match scoring |

Database: run `schema.sql` in the Supabase SQL editor, then `POST /api/backfill` once.

Tunables live in `[vars]` in `wrangler.toml` (not secrets): `SCORE_THRESHOLD`
(default 70), `SCORE_MAX_PER_RUN` (20; `0` pauses scoring), `SCORE_MAX_PER_DAY` (300,
including failed calls), `NOTIFY_MAX_PER_RUN` (10).

Tests (no credentials needed): `npm test` from the repo root.

## Design notes

- **Seeding**: first run marks everything as seen and stays silent — no notification flood.
- **Seen-set**: one KV JSON blob → 1 read per run, rewritten only when jobs were added or closed.
- **Queue before seen**: new jobs are written to `pending-v1` before `seen-v1`; if either write fails the run aborts and the jobs are rediscovered next cycle.
- **Only scored jobs are recommended**: a job is sent only after a successful score ≥ threshold. Scoring failures stay queued and retry every run for up to 24h; then they are dropped, logged and counted in the daily report.
- **Per-run caps without skipping**: at most `SCORE_MAX_PER_RUN` scores and `NOTIFY_MAX_PER_RUN` messages per run; the rest wait in the queue (newest first, ~1/4 of each run reserved for the oldest).
- **Telegram retries**: a match leaves the queue only after Telegram accepts it (at-least-once; a crash between sending and saving could repeat one message).
- **Dedupe**: job id + normalized URL (`seen-v1`), plus company|title|location of sent matches for 14 days (`pending-v1.recent`).
- **Historical jobs are never scored**: only jobs discovered after the queue exists enter it.
- **Scoring errors are classified and retried**: 429 / 5xx / network get one retry in the same run; auth, billing and bad-request errors do not. After 2 consecutive API failures the run stops scoring.
- **Silent failure is visible**: if scoring fails before anything has scored that day, one Telegram alert per cause per day names it (e.g. invalid key, no credit). The daily report includes scoring/sending failures with the last cause, the daily cap, dropped jobs and queue size; a missing report is itself the alarm.

## Budget

| Resource | Usage |
|---|---|
| CPU per run | ~150–250 ms (capped at 5,000 ms by `[limits] cpu_ms`); ~0.3M CPU-ms/month vs 30M included in Paid |
| KV reads / writes | ~150 / ~150 per day |
| Subrequests per run | ≤ ~40 with the default caps (each score attempt and each message is one) |
| Anthropic (Haiku 4.5) | ~$0.001 per score; at most `SCORE_MAX_PER_DAY` per day |

## Before deploying a new version

The deployed Worker may differ from this repository. Before `wrangler deploy`:

1. Save the deployed code (Cloudflare dashboard → Workers & Pages → `jobflow-worker` → Edit code) and note the current version (`npx wrangler deployments list`) so you can roll back with `npx wrangler rollback <version-id>`.
2. Compare it with this repository; anything only in the deployed version is removed by the deploy.
3. `npx wrangler secret list` (names only) to confirm the secrets above exist. `wrangler.toml` replaces vars, cron triggers and bindings configured in the dashboard; secrets and KV/Supabase data are kept.
4. `npx wrangler deploy --dry-run`, then deploy, then `npx wrangler tail` and `POST /api/test-telegram?sample=1`.
