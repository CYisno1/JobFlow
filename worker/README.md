# JobFlow Worker

Cloud brain for JobFlow: Claude API proxy, job crawler on a 30-minute cron,
AI match scoring, and Telegram notifications. Runs on Cloudflare Workers (free tier).

## Architecture

```
cron (30 min) → crawl 2 sources → dedupe (KV) → Supabase jobs (+ Sheet, transitional)
             → score new jobs (Claude Haiku vs RESUME_SUMMARY) → ≥70 → Telegram
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
| GET | `/api/status` | Bearer | health stats (runs/added/scored/notified today) |

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

## Design notes

- **Seeding**: first run marks everything as seen and stays silent — no notification flood.
- **Seen-set**: one KV JSON blob → 1 read + 1 write per run (free-tier write quota).
- **At-least-once**: KV persists last; failures retry next cycle. Downstream writes dedupe.
- **Degrade noisy, not silent**: unscored jobs still notify; a missing daily report is itself the alarm.
- **Cost caps**: Haiku for scoring, ≤25 scored per run.

## Free-tier budget

| Resource | Free limit | Usage |
|---|---|---|
| Worker requests | 100k/day | dozens |
| Cron triggers | 5 | 1 |
| KV reads / writes | 100k / 1k per day | ~96 / ~96 |
