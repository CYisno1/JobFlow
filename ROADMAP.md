# Roadmap

Priorities ranked by (impact on landing offers) ÷ (engineering effort).
The system is in production and feature-complete as an MVP; everything below is deliberate scope.

## Next up

- **Gmail status scanning** — hourly scan of ATS reply emails (greenhouse.io, lever.co, myworkday, ashbyhq…), classify into `rejected / oa / interview`, auto-update `applications.status` via the Supabase REST API, and push interview invitations to Telegram instantly. Closes the loop: today the funnel ends at "applied"; after this, every stage is tracked automatically.
- **Weekly report** — Sunday-evening cron summarizing the week's funnel (new jobs, applications, response rate, interviews). Forces a weekly retrospective: many applications with no responses → fix the resume; interviews without offers → practice interviews.
- **Score calibration loop** — after a few weeks of data, compare "notified" vs "actually applied" vs "got responses" and tune the scoring prompt and threshold from evidence rather than intuition.

## Ledger cleanup

- **Retire the Google Sheet** — the popup now reads Supabase through the Worker; once dual-write parity is verified for a couple of weeks, drop the Sheet write path entirely.
- **Wire up the `documents` table** — store generated resumes/cover letters and record `resume_version` per application, enabling "which resume version converts to interviews" analysis.

## Engineering quality

- **Tests in-repo + CI** — move the test suite into `worker/test/`, run on push via GitHub Actions, auto-deploy on green.
- **Security hardening** — restrict CORS to the extension origin, rate-limit `/api/generate` via KV counters, rotate the bearer token quarterly, migrate to Supabase's new `sb_secret` API keys.
- **Summon the sidebar on any page** — `activeTab` + dynamic script injection to support company-hosted career sites outside the six supported ATS platforms.

## Tool → product (someday)

- **Multi-tenancy** — users table, auth, per-user summaries/chat ids/quotas, one crawl fanning out to per-user scoring. The cloud brain is deliberately single-tenant today; crossing this line is a product project, not a feature.
- **More sources** — the source-adapter pattern makes each new job feed one parse function.

## Deliberate non-goals

- **Auto-submit** — submitting unreviewed AI-generated content risks misrepresentation and wastes one-shot applications. Three steps stay human by design: choose, review, submit.
- **Auto-uploading the cover letter file** — distinguishing the resume input from the cover-letter input across ATS variants is error-prone; the one-click PDF download covers the need.
- **Scraping company-hosted career sites** — unbounded maintenance surface; the six ATS platforms cover the vast majority of applications.
