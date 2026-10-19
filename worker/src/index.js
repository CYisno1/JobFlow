/**
 * JobFlow Worker — cloud brain: API proxy + job crawler + AI scoring.
 *
 * Entry points:
 *   fetch()     — POST /api/generate     Claude API proxy (key never leaves server)
 *                 POST /api/application  record a submitted application
 *                 POST /api/crawl        trigger a crawl manually
 *                 POST /api/test-telegram[?sample=1]  Telegram check / sample match
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
// Defaults; override with [vars] in wrangler.toml (SCORE_THRESHOLD, SCORE_MAX_PER_RUN, NOTIFY_MAX_PER_RUN)
const SCORE_THRESHOLD = 70                         // notify at or above this score
const SCORE_MAX_PER_RUN = 20                       // cost cap per crawl cycle; the rest wait in the queue
const NOTIFY_MAX_PER_RUN = 10                      // Telegram messages per cycle; the rest wait in the queue
const PENDING_TTL_MS = 24 * 60 * 60 * 1000         // retry scoring / sending for at most 24h
const RECENT_TTL_MS = 14 * 24 * 60 * 60 * 1000     // remember sent matches this long (cross-source dedupe)
const MAX_BAD_RESPONSES = 3                        // drop a job whose replies keep failing to parse
const SCORE_FAILURE_BREAKER = 2                    // consecutive API failures → stop scoring this run

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
    scoreMax:  int(env.SCORE_MAX_PER_RUN, SCORE_MAX_PER_RUN, 0, 40),
    notifyMax: int(env.NOTIFY_MAX_PER_RUN, NOTIFY_MAX_PER_RUN, 0, 20),
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
    // Popup dashboard: funnel stats + top open, un-applied jobs (reads Supabase)
    if (url.pathname === '/api/summary' && request.method === 'GET') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401)
      return json(await buildSummary(env))
    }
    return new Response('JobFlow Worker is running!', { headers: CORS })
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCrawler(env))
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

// Returns { score, reason } on success, or { error, kind } on failure:
//   kind 'api'      — the API itself failed (not configured, HTTP error, network);
//                     usually affects every job, so the caller stops early
//   kind 'response' — the API answered but the reply was unusable for this job
export async function scoreJob(env, job) {
  if (!env.RESUME_SUMMARY || !env.ANTHROPIC_API_KEY) {
    return { error: 'RESUME_SUMMARY or ANTHROPIC_API_KEY is not set', kind: 'api' }
  }

  const prompt = `You are screening job postings for a specific candidate. Score how well this job matches the candidate, 0-100.

Scoring guide: 90+ = near-perfect fit (right role type, right level, matching skills). 70-89 = strong fit, worth applying. 50-69 = partial fit. Below 50 = wrong direction.
Consider: role type vs candidate's target roles, required skills overlap, new-grad friendliness, visa sponsorship if mentioned.

=== CANDIDATE ===
${env.RESUME_SUMMARY}

=== JOB ===
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || ''}
Salary: ${job.salary || 'unknown'}

Reply with ONLY this JSON, no other text:
{"score": <int>, "reason": "<one short sentence>"}`

  let res
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SCORE_MODEL,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  } catch (e) {
    return { error: 'network: ' + (e && e.message), kind: 'api' }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { error: `HTTP ${res.status}: ${body.slice(0, 200)}`, kind: 'api' }
  }

  try {
    const data = await res.json()
    const text = data.content?.[0]?.text ?? ''
    const m = text.match(/\{[\s\S]*\}/)   // extract JSON defensively
    if (!m) return { error: 'no JSON in reply', kind: 'response' }
    const parsed = JSON.parse(m[0])
    const score = parseInt(parsed.score, 10)
    if (isNaN(score)) return { error: 'score is not a number', kind: 'response' }
    const reason = String(parsed.reason || '').trim().slice(0, 200)
    return { score: Math.min(100, Math.max(0, score)), reason }
  } catch (e) {
    return { error: 'unparseable reply: ' + (e && e.message), kind: 'response' }
  }
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
  if (unscored.length <= max) return unscored
  const newest = Math.ceil(max * 0.75)
  return [...unscored.slice(0, newest), ...unscored.slice(newest).slice(-(max - newest)).reverse()]
}

async function scorePending(env, pending, cfg, now, log) {
  const rows = []
  let apiFailures = 0
  for (const item of pickForScoring(pending, cfg.scoreMax)) {
    const r = await scoreJob(env, item)
    if (r.error) {
      item.attempts = (item.attempts || 0) + 1
      item.lastError = r.error
      log.scoreFailed++
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
    notified: 0, notifyFailed: 0, pending: 0,
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
  await env.SEEN.put(SEEN_KEY, JSON.stringify(seen))

  // Score what is waiting (bounded per run), then send passing matches
  expirePending(pending, cfg, now, log)
  await scorePending(env, pending, cfg, now, log)
  await notifyPending(env, pending, cfg, now, log)

  log.pending = Object.keys(pending.jobs).length
  await savePending(env, pending)
  await updateHealth(env, log)
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

async function updateHealth(env, log) {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const raw = await env.SEEN.get(HEALTH_KEY)
    let h = raw ? JSON.parse(raw) : null

    // Day rolled over: send yesterday's report, then start a fresh page
    if (h && h.date !== today) {
      await sendTelegram(env,
        `🌙 JobFlow 日報（${h.date}）\n` +
        `巡邏 ${h.runs} 輪｜新職缺 ${h.added}｜評分 ${h.scored}｜推播 ${h.notified}｜關閉 ${h.closed}\n` +
        `評分失敗 ${h.scoreFailed || 0}｜推播失敗 ${h.notifyFailed || 0}｜放棄（超過 24 小時）${h.expired || 0}｜佇列 ${h.pending ?? 0}\n` +
        (h.expired ? `⚠️ 有職缺沒能在 24 小時內完成評分或推播，請查看 Worker logs` : `系統運作正常 ✅`))
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
