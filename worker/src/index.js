/**
 * JobFlow Worker — cloud brain: API proxy + job crawler + AI scoring.
 *
 * Entry points:
 *   fetch()     — POST /api/generate     Claude API proxy (key never leaves server)
 *                 POST /api/application  record a submitted application
 *                 POST /api/crawl        trigger a crawl manually
 *                 POST /api/test-telegram[?sample=1]  Telegram check / sample match
 *                 POST /api/test-score   ONE scoring call on a sample job (billable, ~$0.001)
 *                 POST /api/backfill     one-time: load all open jobs into Supabase
 *                 GET  /api/status       health stats
 *   scheduled() — every 30 min: crawl → write Supabase + Sheet → queue new jobs
 *                 (KV pending-v1) → score from the queue → notify scored matches
 *
 * Secrets (wrangler secret put): ANTHROPIC_API_KEY, WORKER_TOKEN,
 *   TG_BOT_TOKEN, TG_CHAT_ID, SHEET_WEBHOOK_URL, SUPABASE_URL,
 *   SUPABASE_SERVICE_KEY, RESUME_SUMMARY
 */

// ═══════════════ Config ═══════════════

const MODEL = 'claude-sonnet-4-6'                  // resume/cover letter generation
const SCORE_MODEL = 'claude-haiku-4-5-20251001'    // job scoring (cheap + fast)
// Defaults; override with [vars] in wrangler.toml (SCORE_THRESHOLD, SCORE_MAX_PER_RUN,
// SCORE_MAX_PER_DAY, NOTIFY_MAX_PER_RUN)
const SCORE_THRESHOLD = 70                         // notify at or above this score
const SCORE_MAX_PER_RUN = 20                       // cost cap per crawl cycle; the rest wait in the queue
const SCORE_MAX_PER_DAY = 300                      // hard daily cap on scoring calls (UTC day), incl. failures
const NOTIFY_MAX_PER_RUN = 10                      // Telegram messages per cycle; the rest wait in the queue
const PENDING_TTL_MS = 24 * 60 * 60 * 1000         // retry scoring / sending for at most 24h
const RECENT_TTL_MS = 14 * 24 * 60 * 60 * 1000     // remember sent matches this long (cross-source dedupe)
const MAX_BAD_RESPONSES = 3                        // drop a job whose replies keep failing to parse
const SCORE_FAILURE_BREAKER = 2                    // consecutive API failures → stop scoring this run
const SCORE_RETRY_DELAY_MS = 2000                  // one retry for 429 / 5xx / network errors

const SIMPLIFY_REPO   = 'SimplifyJobs/New-Grad-Positions'
const SIMPLIFY_BRANCH = 'dev'
const SPEEDY_REPO     = 'speedyapply/2027-SWE-College-Jobs'
const SPEEDY_FILE     = 'NEW_GRAD_USA.md'

const SIMPLIFY_JSON_URL = `https://raw.githubusercontent.com/${SIMPLIFY_REPO}/${SIMPLIFY_BRANCH}/.github/scripts/listings.json`
const SPEEDY_MD_URL     = `https://raw.githubusercontent.com/${SPEEDY_REPO}/main/${SPEEDY_FILE}`

const KEYWORDS = [
  'software', 'engineer', 'developer', 'data', 'machine learning',
  'full stack', 'fullstack', 'full-stack', 'backend', 'back end', 'back-end',
  'frontend', 'front end', 'front-end', 'mobile', 'infrastructure',
  'platform', 'devops', 'cloud', 'security', 'quant',
]
const KEYWORDS_SHORT_RE = /\b(swe|sde|ml|ai|ios|android)\b/i
const EXCLUDE_RE = /\b(senior|sr|staff|principal|lead|manager|director|intern|internship|internships|phd)\b/i

const SEEN_KEY = 'seen-v1'       // KV: dedupe state (seen job ids/urls)
const HEALTH_KEY = 'health-v1'   // KV: per-day run stats for the daily report
const PENDING_KEY = 'pending-v1' // KV: new jobs waiting to be scored / sent

export function workerConfig(env) {
  const int = (v, def, min, max) => {
    const n = parseInt(v, 10)
    return isNaN(n) ? def : Math.min(max, Math.max(min, n))
  }
  return {
    threshold: int(env.SCORE_THRESHOLD, SCORE_THRESHOLD, 0, 100),
    scoreMax:  int(env.SCORE_MAX_PER_RUN, SCORE_MAX_PER_RUN, 0, 100),
    scoreDailyMax: int(env.SCORE_MAX_PER_DAY, SCORE_MAX_PER_DAY, 0, 2000),
    notifyMax: int(env.NOTIFY_MAX_PER_RUN, NOTIFY_MAX_PER_RUN, 0, 30),
  }
}

// ═══════════════ Entry points ═══════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env)
    }
    if (url.pathname === '/api/application' && request.method === 'POST') {
      return handleApplication(request, env)
    }
    if (url.pathname === '/api/crawl' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      return json(await runCrawler(env))
    }
    if (url.pathname === '/api/backfill' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      return json(await runBackfill(env))
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      const raw = await env.SEEN.get(HEALTH_KEY)
      const pending = Object.values((await loadPending(env, Date.now())).jobs)
      return json({
        ...(raw ? JSON.parse(raw) : { note: 'no health record yet' }),
        config: workerConfig(env),
        // Whether each secret is set — never the values
        configured: Object.fromEntries(['ANTHROPIC_API_KEY', 'RESUME_SUMMARY', 'TG_BOT_TOKEN',
          'TG_CHAT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WORKER_TOKEN']
          .map(k => [k, Boolean(env[k])])),
        queue: {
          unscored: pending.filter(i => i.score == null).length,
          awaitingTelegram: pending.filter(i => i.score != null).length,
        },
      })
    }
    // Diagnostics: send a test message and return Telegram's exact response.
    // ?sample=1 sends a clearly-labelled fake match to check the format.
    if (url.pathname === '/api/test-telegram' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      if (url.searchParams.get('sample')) {
        return json(await sendTelegram(env, '🧪 TEST — sample only, not a real job\n\n' + formatMatch(SAMPLE_MATCH)))
      }
      return json(await sendTelegram(env, '🔧 JobFlow 測試 — Worker → Telegram 通了！'))
    }
    // Diagnostics: exactly one scoring call on a fixed sample job (billable,
    // about $0.001). Returns the score or the classified API error.
    if (url.pathname === '/api/test-score' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      const r = await scoreJob(env, { ...SAMPLE_MATCH, retries: 0 })
      return json(r.error ? { ok: false, ...r } : { ok: true, ...r })
    }
    // Popup dashboard: funnel stats + top open, un-applied jobs (reads Supabase)
    if (url.pathname === '/api/summary' && request.method === 'GET') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      return json(await buildSummary(env))
    }
    return new Response('JobFlow Worker is running!', { headers: CORS })
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCrawler(env).catch(e => {
      console.error('crawler run aborted: ' + (e && e.stack || e))
    }))
  },
}

// ═══════════════ Shared ═══════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function authorized(request, env) {
  const auth = request.headers.get('Authorization') || ''
  return Boolean(env.WORKER_TOKEN) && auth === `Bearer ${env.WORKER_TOKEN}`
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ═══════════════ Supabase helpers (PostgREST API) ═══════════════
// service_role key bypasses RLS — server-side only, never shipped to the browser.

function sbReady(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY)
}

function sbHeaders(env, extra = {}) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

// Batch insert; ignoreDup=true skips rows whose id already exists (idempotent).
async function sbInsert(env, table, rows, ignoreDup = true) {
  if (!sbReady(env) || rows.length === 0) return
  const url = `${env.SUPABASE_URL}/rest/v1/${table}` + (ignoreDup ? '?on_conflict=id' : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: sbHeaders(env, ignoreDup ? { 'Prefer': 'resolution=ignore-duplicates' } : {}),
    body: JSON.stringify(rows),
  })
  if (!res.ok) console.error(`Supabase insert ${table} ${res.status}: ${await res.text()}`)
}

// Batch upsert: update existing rows (merge) or insert missing — ONE request for N rows.
// Free plan allows 50 subrequests per invocation; per-row requests caused a crash loop.
async function sbUpsert(env, table, rows) {
  if (!sbReady(env) || rows.length === 0) return
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: sbHeaders(env, { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  })
  if (!res.ok) console.error(`Supabase upsert ${table} ${res.status}: ${await res.text()}`)
}

// Conditional update; filter uses PostgREST syntax, e.g. id=eq.xxx
async function sbPatch(env, table, filter, patch) {
  if (!sbReady(env)) return
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: sbHeaders(env),
    body: JSON.stringify(patch),
  })
  if (!res.ok) console.error(`Supabase patch ${table} ${res.status}: ${await res.text()}`)
}

async function sbSelect(env, table, filter) {
  if (!sbReady(env)) return []
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: sbHeaders(env),
  })
  if (!res.ok) { console.error(`Supabase select ${table} ${res.status}`); return [] }
  return res.json()
}

// ═══════════════ /api/generate — Claude proxy ═══════════════
// The extension builds prompts locally (personal data stays in the browser);
// this endpoint only attaches the API key and forwards. Streams pass through as-is.

async function handleGenerate(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid JSON' }, 400) }

  const prompt = String(body.prompt || '')
  if (!prompt) return json({ error: 'prompt is required' }, 400)
  if (prompt.length > 60000) return json({ error: 'prompt too long' }, 400)

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      stream: Boolean(body.stream),
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    return json({ error: `Claude API ${res.status}: ${await res.text()}` }, 502)
  }

  if (body.stream) {
    // SSE passthrough: pipe Claude's stream straight to the extension
    return new Response(res.body, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream' },
    })
  }

  const data = await res.json()
  return json({ text: data.content?.[0]?.text ?? '' })
}

// ═══════════════ /api/application — single entry point for submissions ═══════════════
// Extension detects a successful submission → writes Supabase + forwards to Sheet.

async function handleApplication(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid JSON' }, 400) }
  const { company = '', title = '', url = '' } = body
  if (!url) return json({ error: 'url is required' }, 400)

  // Idempotent: same URL recorded today → skip (detection may fire repeatedly)
  const today = new Date().toISOString().slice(0, 10)
  const dup = await sbSelect(env, 'applications',
    `url=eq.${encodeURIComponent(url)}&applied_at=gte.${today}&select=id`)

  if (!dup || dup.length === 0) {
    // Link to the jobs catalog when the URL matches
    const matched = await sbSelect(env, 'jobs', `url=eq.${encodeURIComponent(url)}&select=id`)
    const jobId = matched?.[0]?.id ?? null

    await sbInsert(env, 'applications',
      [{ job_id: jobId, company, title, url, status: 'applied' }], false)
  }

  // Transitional dual-write: Sheet ledger stays in sync (Apps Script dedupes too)
  if (env.SHEET_WEBHOOK_URL) {
    try {
      await fetch(env.SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'application', company, title, url }),
      })
    } catch (e) { console.error('Sheet forward error: ' + (e && e.message)) }
  }

  return json({ ok: true, deduped: dup.length > 0 })
}

// ═══════════════ AI scoring (Claude Haiku) ═══════════════

// Returns { score, reason } on success, or { error, kind, code } on failure:
//   kind 'api'      — the API itself failed (not configured, HTTP error, network);
//                     usually affects every job, so the caller stops early
//   kind 'response' — the API answered but the reply was unusable for this job
//   code            — short cause for logs and alerts, see classifyScoreError
export async function scoreJob(env, job) {
  if (!env.RESUME_SUMMARY || !env.ANTHROPIC_API_KEY) {
    return { error: 'RESUME_SUMMARY or ANTHROPIC_API_KEY is not set', kind: 'api', code: 'not_configured' }
  }

  // Only listing metadata is available (no full job description); the prompt
  // says so, so the model does not invent requirements.
  const prompt = `You are screening job postings for a candidate looking for early-career / new-grad full-time roles. Score how well this job matches the candidate, 0-100.

Scoring guide: 90+ = near-perfect fit (one of the candidate's target role types, genuinely entry-level, matching skills). 70-89 = strong fit, worth applying. 50-69 = partial fit. Below 50 = wrong direction (unrelated role type, or clearly not entry-level).
Consider, in order: role type vs the candidate's target roles; seniority (new-grad / entry-level / "I" titles fit; roles implying several years of experience do not); skills overlap; degree requirements; visa sponsorship if the candidate's background mentions it.
Only the fields below are known about the job; do not assume requirements that are not stated.

=== CANDIDATE ===
${env.RESUME_SUMMARY}

=== JOB ===
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'unknown'}
Salary: ${job.salary || 'unknown'}
Category: ${job.category || 'unknown'}
Degrees: ${job.degrees || 'unknown'}
Sponsorship: ${job.sponsorship || 'unknown'}

Reply with ONLY this JSON, no other text:
{"score": <int>, "reason": "<one short sentence>"}`

  const request = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY.trim(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SCORE_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  // One retry for transient failures (rate limit, overload, 5xx, network).
  // Auth / billing / bad-request errors are not retried: they will not fix themselves.
  const retries = job.retries ?? 1
  let res, failure
  for (let attempt = 0; attempt <= retries; attempt++) {
    failure = null
    try {
      res = await request()
    } catch (e) {
      failure = { error: 'network: ' + (e && e.message), kind: 'api', code: 'network' }
    }
    if (!failure && !res.ok) {
      const body = await res.text().catch(() => '')
      failure = { error: `HTTP ${res.status}: ${body.slice(0, 200)}`, kind: 'api',
        code: classifyScoreError(res.status, body) }
    }
    if (!failure || !['rate_limit', 'overloaded', 'server', 'network'].includes(failure.code)) break
    if (attempt < retries) {
      const after = parseInt(res?.headers?.get('retry-after'), 10)
      const def = parseInt(env.SCORE_RETRY_DELAY_MS ?? SCORE_RETRY_DELAY_MS, 10) || 0
      await new Promise(r => setTimeout(r, Math.min(isNaN(after) ? def : after * 1000, 10000, def * 5)))
    }
  }
  if (failure) return failure

  try {
    const data = await res.json()
    const text = data.content?.[0]?.text ?? ''
    const m = text.match(/\{[\s\S]*\}/)   // extract JSON defensively
    if (!m) return { error: 'no JSON in reply', kind: 'response', code: 'bad_reply' }
    const parsed = JSON.parse(m[0])
    const score = parseInt(parsed.score, 10)
    if (isNaN(score)) return { error: 'score is not a number', kind: 'response', code: 'bad_reply' }
    const reason = String(parsed.reason || '').trim().slice(0, 200)
    return { score: Math.min(100, Math.max(0, score)), reason }
  } catch (e) {
    return { error: 'unparseable reply: ' + (e && e.message), kind: 'response', code: 'bad_reply' }
  }
}

// Anthropic API error → short code. The error body's type field is checked
// first, then the status (https://docs.anthropic.com/en/api/errors).
export function classifyScoreError(status, body = '') {
  if (/credit balance|billing|purchase credits/i.test(body)) return 'credit'
  if (status === 401 || status === 403 || /authentication_error|permission_error/.test(body)) return 'auth'
  if (status === 404 || /not_found_error/.test(body)) return 'model'
  if (status === 429 || /rate_limit_error/.test(body)) return 'rate_limit'
  if (status === 529 || /overloaded_error/.test(body)) return 'overloaded'
  if (status >= 500) return 'server'
  return 'bad_request'
}

// What each code means, in the alert language; the action is what to check
const SCORE_ERROR_HINTS = {
  not_configured: 'ANTHROPIC_API_KEY 或 RESUME_SUMMARY 沒有設定',
  credit: 'Anthropic 帳戶額度不足（請到 Console → Billing 查看）',
  auth: 'API key 無效或已停用（請到 Console → API Keys 查看）',
  model: '評分 model 名稱無效或已停用',
  rate_limit: 'Anthropic 限流（429）',
  overloaded: 'Anthropic 暫時過載（529）',
  server: 'Anthropic 伺服器錯誤（5xx）',
  network: '連不上 Anthropic API',
  bad_request: 'API 請求被拒絕（400）',
  bad_reply: 'AI 回覆格式無法解析',
}

// ═══════════════ Scoring queue (KV: pending-v1) ═══════════════
// New jobs wait here until they are scored and, if they pass the threshold,
// successfully sent to Telegram. Only jobs discovered by the crawler after
// this queue existed ever enter it — historical jobs are never scored.
//
//   jobs[id]    = job fields + discoveredAt, attempts, badResponses,
//                 lastError, score, reason, scoredAt
//   recent[key] = time a match was sent (company|title|location), so the same
//                 role arriving from another source/URL is not sent twice

export async function loadPending(env, now) {
  const raw = await env.SEEN.get(PENDING_KEY)
  const pending = raw ? JSON.parse(raw) : {}
  pending.jobs = pending.jobs || {}
  pending.recent = pending.recent || {}
  for (const [key, at] of Object.entries(pending.recent)) {
    if (now - at > RECENT_TTL_MS) delete pending.recent[key]
  }
  return pending
}

async function savePending(env, pending) {
  await env.SEEN.put(PENDING_KEY, JSON.stringify(pending))
}

export function matchKey(job) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${norm(job.company)}|${norm(job.title)}|${norm(job.location)}`
}

// Drop entries that can no longer succeed. Never silent: logged + counted.
function expirePending(pending, cfg, now, log) {
  for (const [id, item] of Object.entries(pending.jobs)) {
    if (item.score == null) {
      if (now - item.discoveredAt > PENDING_TTL_MS || item.badResponses >= MAX_BAD_RESPONSES) {
        console.error(`unscored job dropped after ${item.attempts} attempts: ${item.company} — ${item.title} (${item.lastError || 'no attempt'})`)
        delete pending.jobs[id]
        log.expired++
      }
    } else if (item.score < cfg.threshold) {
      delete pending.jobs[id]   // threshold was raised since it was scored
    } else if (now - item.scoredAt > PENDING_TTL_MS) {
      console.error(`match never delivered to Telegram: ${item.company} — ${item.title} (${item.lastError || ''})`)
      delete pending.jobs[id]
      log.expired++
    }
  }
}

// Mostly newest first (fresh postings matter most), with about a quarter of
// each run reserved for the oldest waiting jobs so a backlog keeps moving.
export function pickForScoring(pending, max) {
  const unscored = Object.values(pending.jobs)
    .filter(i => i.score == null)
    .sort((a, b) => b.discoveredAt - a.discoveredAt)
  if (max <= 0) return []   // note: slice(-0) would return everything
  if (unscored.length <= max) return unscored
  const newest = Math.ceil(max * 0.75)
  return [...unscored.slice(0, newest), ...unscored.slice(newest).slice(-(max - newest)).reverse()]
}

async function scorePending(env, pending, cfg, now, log, usedToday) {
  const rows = []
  let apiFailures = 0
  const budget = Math.max(0, Math.min(cfg.scoreMax, cfg.scoreDailyMax - usedToday))
  if (budget < cfg.scoreMax && pickForScoring(pending, cfg.scoreMax).length > budget) {
    log.scoreCapped = true
    console.error(`daily scoring cap reached (${cfg.scoreDailyMax}); the rest wait in the queue`)
  }
  for (const item of pickForScoring(pending, budget)) {
    const r = await scoreJob(env, item)
    if (r.error) {
      item.attempts = (item.attempts || 0) + 1
      item.lastError = r.error
      log.scoreFailed++
      log.scoreErrorCode = r.code
      log.scoreError = r.error.slice(0, 200)
      console.error(`score failed (attempt ${item.attempts}) ${item.company} — ${item.title}: ${r.error}`)
      if (r.kind === 'response') {
        item.badResponses = (item.badResponses || 0) + 1
        apiFailures = 0
        continue
      }
      // API-level failure: likely affects every job — stop and retry next run
      if (++apiFailures >= SCORE_FAILURE_BREAKER) break
      continue
    }
    apiFailures = 0
    item.score = r.score
    item.reason = r.reason
    item.scoredAt = now
    log.scored++
    rows.push({
      id: item.id, company: item.company, title: item.title, url: item.url,
      score: r.score, score_reason: r.reason,
    })
    if (r.score < cfg.threshold) delete pending.jobs[item.id]
  }
  // One request for all scores (free plan: 50 subrequests per invocation)
  await sbUpsert(env, 'jobs', rows)
}

// One message per match. A job leaves the queue only after Telegram accepts
// it, so failures are retried next run; the first failure ends this run's
// sending (Telegram down or rate-limited).
async function notifyPending(env, pending, cfg, now, log) {
  const ready = Object.values(pending.jobs)
    .filter(i => i.score != null && i.score >= cfg.threshold)
    .sort((a, b) => b.score - a.score || a.scoredAt - b.scoredAt)

  let sent = 0
  for (const item of ready) {
    const key = matchKey(item)
    if (pending.recent[key]) {
      delete pending.jobs[item.id]
      log.duplicates++
      continue
    }
    if (sent >= cfg.notifyMax) break
    sent++
    const res = await sendTelegram(env, formatMatch(item))
    if (!res.ok) {
      item.lastError = 'telegram: ' + (res.telegramSays || res.error || res.status)
      log.notifyFailed++
      break
    }
    delete pending.jobs[item.id]
    pending.recent[key] = now
    log.notified++
  }
}

const SAMPLE_MATCH = {
  score: 87, company: 'Example Company', title: 'Software Engineer I',
  location: 'New York, NY', salary: '',
  reason: 'Strong Python/backend alignment and suitable early-career level.',
  url: 'https://example.com/jobs/123',
}

export function formatMatch(job) {
  const where = [job.location, job.salary].filter(Boolean).join('｜')
  return [
    '🎯 JobFlow — New Match',
    `<b>${job.score}/100</b> — ${escapeHtml(job.company)} — ${escapeHtml(job.title)}`,
    where ? escapeHtml(where) : null,
    job.reason ? `Reason: ${escapeHtml(job.reason)}` : null,
    `Apply: <a href="${escapeHtml(job.url)}">${escapeHtml(job.url)}</a>`,
  ].filter(Boolean).join('\n')
}

// ═══════════════ Crawler ═══════════════

export async function runCrawler(env, now = Date.now()) {
  const cfg = workerConfig(env)

  // Seen-set stored as one KV blob: one read + one write per run (free-tier friendly)
  const raw = await env.SEEN.get(SEEN_KEY)
  const firstRun = raw === null
  const seen = raw ? JSON.parse(raw) : { ids: {}, urls: {}, closed: {} }

  const newJobs = []
  const closedIds = []
  const newByUrl = new Map()   // this batch, keyed by normalized URL (cross-source salary merge)
  const log = {
    simplify: 0, speedy: 0, added: 0, closed: 0, backfilled: 0,
    queued: 0, duplicates: 0, scored: 0, scoreFailed: 0, expired: 0,
    notified: 0, notifyFailed: 0, pending: 0, scoreCapped: false,
    scoreErrorCode: null, scoreError: null,
    mode: firstRun ? 'seed' : 'normal',
  }

  // Source 1 (primary): Simplify listings.json
  try {
    const res = await fetch(SIMPLIFY_JSON_URL)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const listings = await res.json()
    log.simplify = listings.length

    for (const job of listings) {
      if (!matchesKeywords(job.title + ' ' + (job.category || ''))) continue

      if (seen.ids[job.id]) {
        // Already known: flag closure once
        if (job.active === false && !seen.closed[job.id]) {
          closedIds.push(job.id)
          seen.closed[job.id] = 1
          log.closed++
        }
        continue
      }
      if (job.active !== true || job.is_visible === false) continue

      const norm = normalizeUrl(job.url)
      if (seen.urls[norm] || newByUrl.has(norm)) continue

      const item = {
        company: job.company_name, title: job.title,
        location: (job.locations || []).join('; '),
        salary: '', source: 'simplify', url: job.url, id: job.id,
        category: job.category || '', sponsorship: job.sponsorship || '',
        degrees: (job.degrees || []).join(', '),
      }
      newJobs.push(item)
      newByUrl.set(norm, item)
      seen.ids[job.id] = 1
      seen.urls[norm] = 1
    }
  } catch (e) {
    console.error('Simplify source error: ' + (e && e.message))
  }

  // Source 2 (secondary, has salary): speedyapply markdown table
  try {
    const res = await fetch(SPEEDY_MD_URL)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const jobs = parseSpeedyMarkdown(await res.text())
    log.speedy = jobs.length

    for (const job of jobs) {
      if (!matchesKeywords(job.title)) continue
      const norm = normalizeUrl(job.url)

      // Cross-source duplicate: keep the Simplify record, backfill salary
      if (newByUrl.has(norm)) {
        const item = newByUrl.get(norm)
        if (!item.salary && job.salary) { item.salary = job.salary; log.backfilled++ }
        continue
      }
      if (seen.urls[norm]) continue

      const item = {
        company: job.company, title: job.title, location: job.location,
        salary: job.salary, source: 'speedyapply', url: job.url, id: norm,
        category: '', sponsorship: '', degrees: '',
      }
      newJobs.push(item)
      newByUrl.set(norm, item)
      seen.urls[norm] = 1
    }
  } catch (e) {
    console.error('speedyapply source error: ' + (e && e.message))
  }

  log.added = newJobs.length

  // First run: seed the baseline silently (avoid notification flood)
  if (firstRun) {
    await env.SEEN.put(SEEN_KEY, JSON.stringify(seen))
    await sendTelegram(env, `🐰 JobFlow Worker 首次啟動\n已記住現有 ${newJobs.length} 筆職缺，之後只通知「新出現」的職缺。`)
    return log
  }

  // Write to Supabase (new ledger)
  await sbInsert(env, 'jobs', newJobs.map(j => ({
    id: j.id, company: j.company, title: j.title, url: j.url,
    locations: j.location, salary: j.salary, source: j.source,
    category: j.category, sponsorship: j.sponsorship, active: true,
  })))
  // Mark closures in batches of 30 ids per request (was one PATCH per id —
  // blew the 50-subrequest limit when closures piled up)
  for (let i = 0; i < closedIds.length; i += 30) {
    const list = closedIds.slice(i, i + 30).map(id => `"${id}"`).join(',')
    await sbPatch(env, 'jobs', `id=in.(${encodeURIComponent(list)})`, { active: false })
  }

  // Transitional dual-write to the Sheet ledger
  if ((newJobs.length > 0 || closedIds.length > 0) && env.SHEET_WEBHOOK_URL) {
    try {
      await fetch(env.SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'jobs', jobs: newJobs, closedIds }),
      })
    } catch (e) { console.error('Sheet write error: ' + (e && e.message)) }
  }

  // Queue new jobs, then persist the queue BEFORE the seen-set: if either
  // write fails, the run aborts and the jobs are rediscovered next cycle.
  const pending = await loadPending(env, now)
  for (const j of newJobs) {
    if (pending.jobs[j.id]) continue
    if (pending.recent[matchKey(j)]) { log.duplicates++; continue }
    pending.jobs[j.id] = { ...j, discoveredAt: now, attempts: 0, badResponses: 0 }
    log.queued++
  }
  await savePending(env, pending)
  // seen-v1 is ~2 MB: only rewrite it when something changed (saves CPU and a KV write)
  if (newJobs.length > 0 || closedIds.length > 0) {
    await env.SEEN.put(SEEN_KEY, JSON.stringify(seen))
  }

  // Score what is waiting (bounded per run and per day), then send passing matches
  const health = await loadHealth(env)
  const usedToday = health && !health.stale ? (health.scored || 0) + (health.scoreFailed || 0) : 0
  expirePending(pending, cfg, now, log)
  await scorePending(env, pending, cfg, now, log, usedToday)
  await notifyPending(env, pending, cfg, now, log)

  log.pending = Object.keys(pending.jobs).length
  await savePending(env, pending)
  await updateHealth(env, log, health)
  console.log(JSON.stringify(log))
  return log
}

// ═══════════════ Popup summary ═══════════════
// One call returns everything the popup dashboard needs.
// The service key never leaves the Worker — the popup only holds the bearer token.

async function buildSummary(env) {
  if (!sbReady(env)) return { ok: false, error: 'Supabase not configured' }

  // Row counts via HEAD + Prefer: count=exact (content-range: "0-N/total")
  const count = async (table, filter = '') => {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/${table}?select=id${filter ? '&' + filter : ''}`,
      { method: 'HEAD', headers: sbHeaders(env, { 'Prefer': 'count=exact' }) })
    const range = res.headers.get('content-range') || ''
    return parseInt(range.split('/')[1], 10) || 0
  }

  const [jobsTotal, jobsOpen] = await Promise.all([
    count('jobs'), count('jobs', 'active=eq.true'),
  ])

  const apps = await sbSelect(env, 'applications',
    'select=url,status&order=applied_at.desc&limit=1000')
  const appliedUrls = new Set(apps.map(a => a.url))
  const byStatus = {}
  for (const a of apps) {
    const s = a.status || 'applied'
    byStatus[s] = (byStatus[s] || 0) + 1
  }

  // Top open jobs by score; exclude already-applied (filtered here — PostgREST has no subqueries)
  const rows = await sbSelect(env, 'jobs',
    'select=company,title,url,locations,salary,score,source,created_at' +
    '&active=eq.true&order=score.desc.nullslast,created_at.desc&limit=40')
  const jobs = (rows || []).filter(j => !appliedUrls.has(j.url)).slice(0, 15).map(j => ({
    date: (j.created_at || '').slice(0, 10),
    company: j.company, title: j.title, location: j.locations || '',
    salary: j.salary || '', source: j.source || '', url: j.url, score: j.score,
  }))

  return {
    ok: true,
    stats: { jobsTotal, jobsOpen, applied: apps.length, byStatus },
    jobs,
    updatedAt: new Date().toISOString(),
  }
}

// ═══════════════ Health monitoring ═══════════════
// Makes silent failure visible: stats accumulate per day in KV, and the first
// run after midnight sends yesterday's report. A missing report IS the alarm.

// Today's health record, or null if none yet / it belongs to an earlier day.
// The daily scoring cap counts from this.
async function loadHealth(env) {
  try {
    const raw = await env.SEEN.get(HEALTH_KEY)
    const h = raw ? JSON.parse(raw) : null
    return h && h.date === new Date().toISOString().slice(0, 10) ? h : (h ? { ...h, stale: true } : null)
  } catch (e) {
    console.error('health read error: ' + (e && e.message))
    return null
  }
}

export function formatDailyReport(h) {
  const warnings = []
  if (h.scoreFailed && !h.scored) {
    warnings.push(`⚠️ 今天評分全部失敗，沒有推薦任何職缺。原因：${SCORE_ERROR_HINTS[h.lastScoreErrorCode] || h.lastScoreErrorCode || '不明'}`)
  } else if (h.scoreFailed) {
    warnings.push(`⚠️ 部分評分失敗，最近一次的原因：${SCORE_ERROR_HINTS[h.lastScoreErrorCode] || h.lastScoreErrorCode || '不明'}`)
  }
  if (h.scoreCapped) warnings.push('⚠️ 達到每日評分上限，其餘職缺留在佇列中')
  if (h.expired) warnings.push('⚠️ 有職缺沒能在 24 小時內完成評分或推播，請查看 Worker logs')
  return `🌙 JobFlow 日報（${h.date}）\n` +
    `巡邏 ${h.runs} 輪｜新職缺 ${h.added}｜評分 ${h.scored}｜推播 ${h.notified}｜關閉 ${h.closed}\n` +
    `評分失敗 ${h.scoreFailed || 0}｜推播失敗 ${h.notifyFailed || 0}｜放棄（超過 24 小時）${h.expired || 0}｜佇列 ${h.pending ?? 0}\n` +
    (warnings.length ? warnings.join('\n') : '系統運作正常 ✅')
}

async function updateHealth(env, log, current) {
  try {
    const today = new Date().toISOString().slice(0, 10)
    let h = current === undefined ? await loadHealth(env) : current

    // Day rolled over: send yesterday's report, then start a fresh page
    if (h && h.stale) {
      delete h.stale
      await sendTelegram(env, formatDailyReport(h))
      h = null
    }
    if (!h) h = { date: today, runs: 0, added: 0, scored: 0, notified: 0, closed: 0 }

    h.runs++
    h.added    += log.added
    h.scored   += log.scored
    h.notified += log.notified
    h.closed   += log.closed
    h.scoreFailed  = (h.scoreFailed || 0) + log.scoreFailed
    h.notifyFailed = (h.notifyFailed || 0) + log.notifyFailed
    h.expired      = (h.expired || 0) + log.expired
    h.pending      = log.pending
    h.lastRun = new Date().toISOString()
    if (log.scoreCapped) h.scoreCapped = true
    if (log.scoreErrorCode) {
      h.lastScoreErrorCode = log.scoreErrorCode
      h.lastScoreError = log.scoreError
      h.lastScoreErrorAt = h.lastRun
    }

    // Scoring is failing and nothing has scored today: alert once per day per
    // cause, instead of waiting for tomorrow's report. Jobs stay queued for 24h.
    const code = log.scoreErrorCode
    if (code && code !== 'bad_reply' && !h.scored && !(h.alerted || {})[code]) {
      const r = await sendTelegram(env,
        `⚠️ JobFlow 評分失敗：${SCORE_ERROR_HINTS[code] || code}\n` +
        `新職缺會留在佇列中，24 小時內每輪自動重試。修好之後不需要其他操作。`)
      if (r.ok) h.alerted = { ...(h.alerted || {}), [code]: true }
    }

    await env.SEEN.put(HEALTH_KEY, JSON.stringify(h))
  } catch (e) {
    console.error('health record error: ' + (e && e.message))
  }
}

// ═══════════════ /api/backfill — one-time catalog load ═══════════════
// Loads all currently-open matching jobs into Supabase (no scoring, no notifications).

async function runBackfill(env) {
  if (!sbReady(env)) return { error: 'set SUPABASE_URL and SUPABASE_SERVICE_KEY first' }
  const rows = []
  try {
    const res = await fetch(SIMPLIFY_JSON_URL)
    const listings = await res.json()
    for (const job of listings) {
      if (!matchesKeywords(job.title + ' ' + (job.category || ''))) continue
      if (job.active !== true || job.is_visible === false) continue
      rows.push({
        id: job.id, company: job.company_name, title: job.title, url: job.url,
        locations: (job.locations || []).join('; '), salary: '',
        source: 'simplify', category: job.category || '',
        sponsorship: job.sponsorship || '', active: true,
      })
    }
  } catch (e) {
    return { error: 'Simplify fetch failed: ' + (e && e.message) }
  }

  // Insert in batches of 500 (single oversized requests get rejected)
  for (let i = 0; i < rows.length; i += 500) {
    await sbInsert(env, 'jobs', rows.slice(i, i + 500))
  }
  return { backfilled: rows.length }
}

// ═══════════════ Telegram ═══════════════

// Returns a result object so callers (and /api/test-telegram) can see what happened
async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return { ok: false, error: 'TG_BOT_TOKEN or TG_CHAT_ID is not set' }
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID.trim(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const body = await res.text()
    if (!res.ok) {
      console.error(`Telegram ${res.status}: ${body}`)
      return { ok: false, status: res.status, telegramSays: body }
    }
    return { ok: true }
  } catch (e) {
    console.error('Telegram error: ' + (e && e.message))
    return { ok: false, error: String(e && e.message) }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ═══════════════ Parsing & utilities ═══════════════

// speedyapply markdown table rows:
//   FAANG+/Quant: | company | title | location | salary | apply | age |
//   Other:        | company | title | location | apply | age |
export function parseSpeedyMarkdown(md) {
  const jobs = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || line.indexOf('href=') === -1) continue

    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 5) continue

    const hasSalary = cells.length >= 6
    const company   = stripTags(cells[0])
    const title     = stripTags(cells[1])
    const location  = stripTags(cells[2])
    const salary    = hasSalary ? stripTags(cells[3]) : ''
    const applyCell = hasSalary ? cells[4] : cells[3]

    const m = applyCell.match(/href="(https?:\/\/[^"]+)"/)
    if (!m || !company || !title) continue

    jobs.push({ company, title, location, salary, url: m[1] })
  }
  return jobs
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// Normalize URLs so different spellings of the same job become one key:
// strip fragments, tracking params (utm_* etc.) and trailing slashes; lowercase.
export function normalizeUrl(url) {
  let u = String(url).trim().replace(/#.*$/, '')
  const qIdx = u.indexOf('?')
  let base = qIdx === -1 ? u : u.slice(0, qIdx)
  let keep = ''
  if (qIdx !== -1) {
    const params = u.slice(qIdx + 1).split('&').filter(p =>
      !/^(utm_|ref=|ref_|source=|src=|gh_src=|lever-origin=|origin=)/i.test(p))
    if (params.length > 0) keep = '?' + params.sort().join('&')
  }
  return (base.replace(/\/+$/, '') + keep).toLowerCase()
}

export function matchesKeywords(text) {
  const t = String(text).toLowerCase()
  if (EXCLUDE_RE.test(t)) return false
  if (KEYWORDS.some(kw => t.indexOf(kw) !== -1)) return true
  return KEYWORDS_SHORT_RE.test(t)
}
