# JobFlow

An end-to-end job application automation system for new grad software engineering roles. It discovers openings around the clock, tailors application materials with AI, autofills six different ATS platforms, and tracks every application in a single ledger — turning a 13-step job hunt into three human decisions: *choose, review, submit*.

## What it does

- **24/7 job discovery** — a scheduled scraper ingests two structured sources (SimplifyJobs `listings.json` and speedyapply's machine-generated markdown), dedupes across sources by unique ID and normalized URL, merges salary data, and flags closed postings automatically.
- **One-click autofill across 6 ATS platforms** — Greenhouse, Lever, Workday, JazzHR, Oracle Cloud, and Ashby adapters fill contact info, LinkedIn/GitHub/portfolio fields, and inject the resume PDF directly into file inputs (including Workday's "Autofill with Resume" flow).
- **AI-tailored materials** — a sidebar extracts the full job description from the page and generates a customized resume and cover letter via the Claude API, with human review before anything is submitted.
- **Automatic application tracking** — a content script detects ATS confirmation pages and records the application to a Google Sheet ledger without any manual entry. The extension popup shows the funnel: open jobs, total tracked, applications submitted.

## Architecture

```
GitHub sources ──► Apps Script cron (30 min) ──► Google Sheet (single ledger)
                                                    ▲            │
                          submit detection ────────┘            ▼
Chrome Extension (MV3) ◄── content scripts        popup dashboard (funnel stats)
  ├─ sidebar: JD capture → AI resume/CL
  └─ ATS adapters: autofill + PDF injection
```

Design principles: the browser extension does only what *requires* a browser (DOM interaction); scheduled work and data live in the cloud; one source of truth for all records. Migration to Cloudflare Workers (API key proxy, scoring, notifications) and Supabase is planned as phases 2–3.

## Stack

TypeScript · Chrome Extension Manifest V3 · Vite · Google Apps Script · Claude API

## Deliberately manual

Three steps are intentionally left to the human: deciding whether to apply, reviewing AI-generated content, and clicking submit. Automation should amplify judgment, not replace it.
