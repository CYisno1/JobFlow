# JobFlow

An end-to-end job application automation system for new grad software engineering roles. It discovers openings around the clock, scores each one against my background with AI, tailors application materials, autofills six different ATS platforms, and tracks every application automatically — turning a 13-step job hunt into three human decisions: *choose, review, submit*.

## What it does

- **24/7 job discovery** — a Cloudflare Worker crawls two structured sources (SimplifyJobs `listings.json` and speedyapply's machine-generated markdown) every 30 minutes, dedupes across sources by unique ID and normalized URL, merges salary data, and flags closed postings automatically.
- **AI match scoring** — every new posting is scored 0–100 against my background summary (Claude Haiku); only strong matches (≥70) reach my phone via Telegram, with the score and a one-line reason.
- **One-click autofill across 6 ATS platforms** — Greenhouse, Lever, Workday, JazzHR, Oracle Cloud, and Ashby adapters fill contact info, LinkedIn/GitHub/portfolio fields, and inject the resume PDF directly into file inputs (including Workday's "Autofill with Resume" flow).
- **AI-tailored materials** — a sidebar extracts the full job description and generates a customized resume and cover letter through the Worker proxy (SSE streaming), with human review before anything is submitted.
- **Automatic application tracking** — a content script detects ATS confirmation pages and records the application to Supabase (and the Google Sheet ledger) with zero manual entry.
- **Self-monitoring** — per-day run stats in Workers KV and a nightly Telegram report; a missing report is itself the alarm.

## Architecture

```
                       ┌────────────────────────────────────────────┐
  GitHub sources ────► │       Cloudflare Worker (cron 30 min)      │
  (Simplify /          │                                            │
   speedyapply)        │  crawl → dedupe (KV) → score (Haiku)       │
                       │    │                     │                 │
                       └────┼─────────────────────┼─────────────────┘
                            │                     │ score ≥ 70
                            ▼                     ▼
                     Supabase (ledger)      Telegram alerts
                     + Google Sheet
                     (transitional)
                            ▲
                            │ POST /api/application
                       ┌────┴───────────────────────────────────────┐
                       │         Chrome Extension (MV3)             │
                       │                                            │
                       │  content scripts: JD capture,              │
                       │    ATS autofill + PDF injection,           │
                       │    submit detection                        │
                       │  sidebar: AI resume / cover letter         │
                       │    (via Worker /api/generate, streamed)    │
                       └────────────────────────────────────────────┘
```

Design principles: the browser extension does only what *requires* a browser (DOM interaction); scheduled work, secrets and data live in the cloud; API keys never touch the client; one source of truth for all records; degrade noisy, never silent.

## Stack

TypeScript · Chrome Extension Manifest V3 · Vite · Cloudflare Workers (cron, KV) · Supabase (PostgreSQL) · Claude API (Sonnet for generation, Haiku for scoring) · Telegram Bot API · Google Apps Script

## Repo layout

```
src/         Chrome extension (content scripts, sidebar, popup, background)
worker/      Cloudflare Worker (crawler, AI proxy, scoring, notifications)
apps-script.gs   Google Sheet ledger webhook (transitional)
```

## Deliberately manual

Three steps are intentionally left to the human: deciding whether to apply, reviewing AI-generated content, and clicking submit. Automation should amplify judgment, not replace it.
