// Worker crawler / scoring / Telegram tests. No network, no credentials:
// fetch and KV are replaced with in-memory fakes.
// Run: npm test (from the repo root)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCrawler, scoreJob, pickForScoring, formatMatch, matchKey, workerConfig,
  classifyScoreError, formatDailyReport, matchesKeywords, safeApplyUrl,
  parseSpeedyAiMarkdown, parseMlNewgradMarkdown, parseAgnikuluJson,
} from '../src/index.js'
import worker from '../src/index.js'

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0)

function listing(i, extra = {}) {
  return {
    id: `sim-${i}`, company_name: `Company ${i}`, title: 'Software Engineer I',
    category: 'Software', active: true, is_visible: true,
    url: `https://jobs.example.com/${i}`, locations: ['New York, NY'],
    degrees: ["Bachelor's"], sponsorship: 'Other', ...extra,
  }
}

// Exact source URLs: each one has its own fixture, so a fixture can never be
// served for the wrong source (both speedyapply files are NEW_GRAD_USA.md)
const URLS = {
  simplify: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  speedy: 'https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md',
  speedyAi: 'https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/NEW_GRAD_USA.md',
  mlNewgrad: 'https://raw.githubusercontent.com/Tar-ive/ML_Newgrad_2027/main/README.md',
  agnikulu: 'https://raw.githubusercontent.com/Agnikulu/Job-Postings/main/jobs_archive.json',
}

// In-memory world: KV, GitHub sources, Claude, Telegram, Supabase.
// speedyAi / mlNewgrad / agnikulu: fixture text, or null → HTTP 404.
function world({ listings = [], speedy = '', speedyAi = null, mlNewgrad = null, agnikulu = null,
  seen = { ids: {}, urls: {}, closed: {} }, vars = {} } = {}) {
  const kv = new Map()
  if (seen) kv.set('seen-v1', JSON.stringify(seen))
  const w = {
    kv, listings, speedy, speedyAi, mlNewgrad, agnikulu,
    sourceStatus: {},   // URLS key (e.g. mlNewgrad) → HTTP status to return instead of the fixture
    score: () => ({ score: 85, reason: 'Good fit.' }),   // per-job behaviour, by company
    telegramOk: () => true,
    failKvPut: null,
    failKvGet: null,
    calls: { claude: 0, telegram: 0, supabase: 0, total: 0, sources: {}, other: [] },
    messages: [],
    prompts: [],
  }
  w.env = {
    SEEN: {
      get: async k => {
        if (w.failKvGet === k) throw new Error('KV read failed')
        return kv.get(k) ?? null
      },
      put: async (k, v) => {
        if (w.failKvPut === k) throw new Error('KV write failed')
        kv.set(k, v)
      },
    },
    RESUME_SUMMARY: 'MS CS; Python, TypeScript; targets SWE / backend roles.',
    ANTHROPIC_API_KEY: 'test-key',
    TG_BOT_TOKEN: 'test-token',
    TG_CHAT_ID: '123',
    SUPABASE_URL: 'https://sb.example.com',
    SUPABASE_SERVICE_KEY: 'sb-key',
    SCORE_RETRY_DELAY_MS: '0',
    ...vars,
  }
  w.fetch = async (url, opts = {}) => {
    url = String(url)
    w.calls.total++
    const source = Object.keys(URLS).find(k => URLS[k] === url)
    if (source) {
      w.calls.sources[source] = (w.calls.sources[source] || 0) + 1
      if (opts.headers) throw new Error('job boards must not receive headers / credentials')
      if (w.sourceStatus[source]) return new Response('upstream error', { status: w.sourceStatus[source] })
      const body = source === 'simplify' ? JSON.stringify(w.listings) : w[source]
      return body == null ? new Response('404: Not Found', { status: 404 }) : new Response(body)
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      throw new Error('unexpected source URL ' + url)
    }
    if (url.includes('api.anthropic.com')) {
      w.calls.claude++
      const prompt = JSON.parse(opts.body).messages[0].content
      w.prompts.push(prompt)
      const company = prompt.match(/^Company: (.*)$/m)[1]
      const r = w.score(company)
      if (r.http) return new Response(r.body || 'upstream error', { status: r.http })
      if (r.raw != null) return new Response(JSON.stringify({ content: [{ text: r.raw }] }))
      return new Response(JSON.stringify({ content: [{ text: JSON.stringify(r) }] }))
    }
    if (url.includes('api.telegram.org')) {
      w.calls.telegram++
      const text = JSON.parse(opts.body).text
      if (!w.telegramOk(text)) return new Response('{"ok":false,"description":"Too Many Requests"}', { status: 429 })
      w.messages.push(text)
      return new Response('{"ok":true}')
    }
    if (url.startsWith('https://sb.example.com')) {
      w.calls.supabase++
      return new Response('[]')
    }
    w.calls.other.push(url)   // no application URL is ever fetched
    return new Response('{}')
  }
  w.run = async (at) => {
    globalThis.fetch = w.fetch
    return runCrawler(w.env, at)
  }
  w.pending = () => JSON.parse(kv.get('pending-v1') || '{"jobs":{},"recent":{}}')
  return w
}

const matches = w => w.messages.filter(m => m.includes('New Match'))
const alerts = w => w.messages.filter(m => m.includes('評分失敗：'))

// ── Only newly discovered jobs ─────────────────────────────

test('first run seeds silently: nothing scored or recommended', async () => {
  const w = world({ listings: [listing(1), listing(2)], seen: null })
  const log = await w.run(T0)
  assert.equal(log.mode, 'seed')
  assert.equal(w.calls.claude, 0)
  assert.equal(matches(w).length, 0)
  assert.equal(w.kv.has('pending-v1'), false)
})

test('historical jobs (already in seen-v1) are never queued or scored', async () => {
  const w = world({
    listings: [listing(1), listing(2)],
    seen: { ids: { 'sim-1': 1, 'sim-2': 1 }, urls: {}, closed: {} },
  })
  const log = await w.run(T0)
  assert.equal(log.queued, 0)
  assert.equal(w.calls.claude, 0)
  assert.equal(matches(w).length, 0)
})

test('new job: scored, then recommended with the expected format', async () => {
  const w = world({ listings: [listing(1)] })
  const log = await w.run(T0)
  assert.equal(log.queued, 1)
  assert.equal(log.scored, 1)
  assert.equal(log.notified, 1)
  assert.equal(matches(w)[0], [
    '🎯 JobFlow — New Match',
    '<b>85/100</b> — Company 1 — Software Engineer I',
    'New York, NY',
    'Reason: Good fit.',
    'Apply: <a href="https://jobs.example.com/1">https://jobs.example.com/1</a>',
  ].join('\n'))
  assert.equal(Object.keys(w.pending().jobs).length, 0, 'queue drained')
})

// ── Never recommend unscored jobs ──────────────────────────

test('scoring API down: nothing is sent, jobs stay queued, breaker stops early', async () => {
  const w = world({ listings: [1, 2, 3, 4, 5].map(i => listing(i)) })
  w.score = () => ({ http: 529 })
  const log = await w.run(T0)
  assert.equal(w.calls.claude, 4, '2 jobs × (1 try + 1 retry), then the breaker stops')
  assert.equal(log.scoreFailed, 2)
  assert.equal(matches(w).length, 0, 'no unscored recommendations')
  assert.equal(alerts(w).length, 1, 'one failure alert')
  assert.equal(Object.keys(w.pending().jobs).length, 5)
})

test('missing RESUME_SUMMARY: nothing is sent unscored', async () => {
  const w = world({ listings: [listing(1)], vars: { RESUME_SUMMARY: '' } })
  const log = await w.run(T0)
  assert.equal(log.scoreFailed >= 1, true)
  assert.equal(w.calls.claude, 0)
  assert.equal(matches(w).length, 0)
  assert.ok(alerts(w)[0].includes('沒有設定'))
  assert.equal(Object.keys(w.pending().jobs).length, 1)
})

test('temporary scoring failure is retried on the next run', async () => {
  const w = world({ listings: [listing(1)] })
  w.score = () => ({ http: 500 })
  await w.run(T0)
  assert.equal(matches(w).length, 0)
  w.score = () => ({ score: 90, reason: 'Great.' })
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.scored, 1)
  assert.equal(matches(w).length, 1)
})

test('job still unscored after 24h is dropped, counted, and never sent', async () => {
  const w = world({ listings: [listing(1)] })
  w.score = () => ({ http: 500 })
  await w.run(T0)
  await w.run(T0 + 23 * HOUR)
  assert.equal(Object.keys(w.pending().jobs).length, 1, 'still retried within 24h')
  w.score = () => ({ score: 99, reason: 'too late' })
  const log = await w.run(T0 + 25 * HOUR)
  assert.equal(log.expired, 1)
  assert.equal(matches(w).length, 0)
  assert.equal(Object.keys(w.pending().jobs).length, 0)
})

test('repeatedly unparseable replies drop the job after 3 tries (no unscored send)', async () => {
  const w = world({ listings: [listing(1), listing(2)] })
  w.score = c => c === 'Company 1' ? { raw: 'I think it is a good fit' } : { score: 80, reason: 'ok' }
  for (let r = 0; r < 4; r++) await w.run(T0 + r * HOUR / 2)
  assert.equal(matches(w).length, 1)
  assert.ok(matches(w)[0].includes('Company 2'))
  assert.equal(Object.keys(w.pending().jobs).length, 0)
})

// ── Per-run cap never silently skips ───────────────────────

test('more new jobs than the per-run cap: all get scored over later runs', async () => {
  const w = world({ listings: Array.from({ length: 45 }, (_, i) => listing(i)) })
  w.score = () => ({ score: 50, reason: 'meh' })   // below threshold: no Telegram noise
  const l1 = await w.run(T0)
  assert.equal(l1.scored, 20)
  assert.equal(l1.pending, 25)
  const l2 = await w.run(T0 + HOUR / 2)
  assert.equal(l2.scored, 20)
  const l3 = await w.run(T0 + HOUR)
  assert.equal(l3.scored, 5)
  assert.equal(l3.pending, 0)
  assert.equal(w.calls.claude, 45, 'each job scored exactly once')
})

test('pickForScoring: newest first, about a quarter reserved for the oldest', () => {
  const jobs = {}
  for (let i = 0; i < 30; i++) jobs[`j${i}`] = { id: `j${i}`, discoveredAt: T0 + i * HOUR }
  jobs.done = { id: 'done', discoveredAt: T0 + 99 * HOUR, score: 80 }
  const picked = pickForScoring({ jobs }, 20).map(j => j.id)
  assert.equal(picked.length, 20)
  assert.deepEqual(picked.slice(0, 15), Array.from({ length: 15 }, (_, i) => `j${29 - i}`))
  assert.deepEqual(picked.slice(15), ['j0', 'j1', 'j2', 'j3', 'j4'])
  assert.ok(!picked.includes('done'))
})

test('pickForScoring with a cap of 0 picks nothing (SCORE_MAX_PER_RUN="0" pauses scoring)', () => {
  const jobs = { a: { id: 'a', discoveredAt: T0 }, b: { id: 'b', discoveredAt: T0 + 1 } }
  assert.deepEqual(pickForScoring({ jobs }, 0), [])
})

test('run stays within the free-plan subrequest budget with a large backlog', async () => {
  const w = world({ listings: Array.from({ length: 200 }, (_, i) => listing(i)) })
  w.score = () => ({ score: 95, reason: 'great' })
  await w.run(T0)
  assert.ok(w.calls.total <= 45, `used ${w.calls.total} subrequests`)
  assert.equal(matches(w).length, 10, 'notify cap respected; rest wait')
})

// ── Threshold ──────────────────────────────────────────────

test('threshold: 70 is sent, 69 is not', async () => {
  const w = world({ listings: [listing(1), listing(2)] })
  w.score = c => ({ score: c === 'Company 1' ? 70 : 69, reason: 'x' })
  await w.run(T0)
  assert.equal(matches(w).length, 1)
  assert.ok(matches(w)[0].includes('70/100'))
})

test('threshold is configurable via SCORE_THRESHOLD', async () => {
  const w = world({ listings: [listing(1)], vars: { SCORE_THRESHOLD: '90' } })
  w.score = () => ({ score: 85, reason: 'x' })
  await w.run(T0)
  assert.equal(matches(w).length, 0)
})

test('workerConfig defaults and clamping', () => {
  assert.deepEqual(workerConfig({}), { threshold: 70, scoreMax: 20, scoreDailyMax: 300, notifyMax: 10 })
  assert.deepEqual(workerConfig({
    SCORE_THRESHOLD: '250', SCORE_MAX_PER_RUN: 'x', NOTIFY_MAX_PER_RUN: '-3', SCORE_MAX_PER_DAY: '99999',
  }), { threshold: 100, scoreMax: 20, scoreDailyMax: 2000, notifyMax: 0 })
})

// ── Duplicate prevention ───────────────────────────────────

test('repeated crawls of the same listings send nothing new', async () => {
  const w = world({ listings: [listing(1), listing(2)] })
  await w.run(T0)
  await w.run(T0 + HOUR / 2)
  await w.run(T0 + HOUR)
  assert.equal(matches(w).length, 2)
  assert.equal(w.calls.claude, 2)
})

test('same role from the second source with a different URL is sent once', async () => {
  const speedy = '| Company 1 | Software Engineer I | New York, NY | <a href="https://careers.company1.com/apply/77">Apply</a> | 1d |\n'
  const w = world({ listings: [listing(1)], speedy })
  await w.run(T0)
  assert.equal(matches(w).length, 1)
})

test('same role appearing in a later crawl from another URL is not sent again', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  w.listings = [listing(1), listing(2, { company_name: 'Company 1', url: 'https://other.example.com/x' })]
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(matches(w).length, 1)
  assert.equal(log.duplicates, 1)
  assert.equal(w.calls.claude, 1, 'duplicate not even scored')
})

test('URL normalization: tracking params do not create a second job', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  w.listings = [listing(1), listing(9, { url: 'https://jobs.example.com/1/?utm_source=x', company_name: 'Renamed Co' })]
  await w.run(T0 + HOUR / 2)
  assert.equal(w.calls.claude, 1)
})

// ── Telegram failures ──────────────────────────────────────

test('Telegram failure: job kept and sent exactly once on a later run', async () => {
  const w = world({ listings: [listing(1), listing(2)] })
  w.telegramOk = () => false
  const l1 = await w.run(T0)
  assert.equal(l1.notifyFailed, 1)
  assert.equal(w.calls.telegram, 1, 'stops sending after the first failure')
  assert.equal(Object.keys(w.pending().jobs).length, 2)

  w.telegramOk = () => true
  await w.run(T0 + HOUR / 2)
  await w.run(T0 + HOUR)
  assert.equal(matches(w).length, 2)
  assert.equal(new Set(matches(w)).size, 2, 'no duplicates')
  assert.equal(w.calls.claude, 2, 'scores are not recomputed for retries')
})

test('Telegram not configured: matches wait, nothing lost', async () => {
  const w = world({ listings: [listing(1)], vars: { TG_BOT_TOKEN: '' } })
  await w.run(T0)
  assert.equal(Object.values(w.pending().jobs)[0].score, 85)
})

test('match that cannot be delivered for 24h is dropped and counted', async () => {
  const w = world({ listings: [listing(1)] })
  w.telegramOk = () => false
  await w.run(T0)
  const log = await w.run(T0 + 25 * HOUR)
  assert.equal(log.expired, 1)
  assert.equal(Object.keys(w.pending().jobs).length, 0)
})

// ── Queue is saved before the seen-set ─────────────────────

test('if the queue cannot be saved, jobs are not marked seen and are found again', async () => {
  const w = world({ listings: [listing(1)] })
  w.failKvPut = 'pending-v1'
  await assert.rejects(w.run(T0))
  assert.deepEqual(JSON.parse(w.kv.get('seen-v1')).ids, {}, 'seen-set untouched')
  assert.equal(w.calls.telegram, 0)

  w.failKvPut = null
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.queued, 1)
  assert.equal(matches(w).length, 1)
})

test('existing KV keys keep their shape', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  const seen = JSON.parse(w.kv.get('seen-v1'))
  assert.deepEqual(Object.keys(seen).sort(), ['closed', 'ids', 'urls'])
  assert.equal(seen.ids['sim-1'], 1)
})

// ── Scoring prompt ─────────────────────────────────────────

test('prompt includes listing metadata already available', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  const p = w.prompts[0]
  for (const s of ['Category: Software', "Degrees: Bachelor's", 'Sponsorship: Other', 'early-career', 'MS CS']) {
    assert.ok(p.includes(s), `prompt has ${s}`)
  }
})

test('scoreJob distinguishes API failures from bad replies', async () => {
  const env = { RESUME_SUMMARY: 'x', ANTHROPIC_API_KEY: 'k', SCORE_RETRY_DELAY_MS: '0' }
  globalThis.fetch = async () => new Response('nope', { status: 401 })
  assert.equal((await scoreJob(env, {})).kind, 'api')
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.equal((await scoreJob(env, {})).kind, 'api')
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ text: '{"score": "high"}' }] }))
  assert.equal((await scoreJob(env, {})).kind, 'response')
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ text: 'Sure! {"score": 140, "reason": "r"}' }] }))
  assert.deepEqual(await scoreJob(env, {}), { score: 100, reason: 'r' })
})

// ── Formatting ─────────────────────────────────────────────

test('formatMatch escapes HTML and omits empty lines', () => {
  const text = formatMatch({
    score: 77, company: 'A&B <Labs>', title: 'SWE "I"', location: '', salary: '',
    reason: '', url: 'https://x.example.com/j?a=1&b="2"',
  })
  assert.equal(text, [
    '🎯 JobFlow — New Match',
    '<b>77/100</b> — A&amp;B &lt;Labs&gt; — SWE &quot;I&quot;',
    'Apply: <a href="https://x.example.com/j?a=1&amp;b=&quot;2&quot;">https://x.example.com/j?a=1&amp;b=&quot;2&quot;</a>',
  ].join('\n'))
})

test('matchKey ignores case and punctuation', () => {
  assert.equal(matchKey({ company: 'Acme, Inc.', title: 'Software Engineer I', location: 'New York, NY' }),
    matchKey({ company: 'ACME Inc', title: 'software engineer i', location: 'New York NY' }))
})

// ── Scoring failures are classified, retried once, and alerted ──

test('classifyScoreError maps Anthropic errors to causes', () => {
  const body = (type, message) => JSON.stringify({ type: 'error', error: { type, message } })
  assert.equal(classifyScoreError(401, body('authentication_error', 'invalid x-api-key')), 'auth')
  assert.equal(classifyScoreError(400, body('invalid_request_error',
    'Your credit balance is too low to access the Anthropic API.')), 'credit')
  assert.equal(classifyScoreError(400, body('invalid_request_error', 'max_tokens: bad')), 'bad_request')
  assert.equal(classifyScoreError(404, body('not_found_error', 'model: x')), 'model')
  assert.equal(classifyScoreError(429, body('rate_limit_error', 'slow down')), 'rate_limit')
  assert.equal(classifyScoreError(529, body('overloaded_error', 'Overloaded')), 'overloaded')
  assert.equal(classifyScoreError(503, ''), 'server')
})

test('transient error is retried once within the run; auth error is not', async () => {
  const env = { RESUME_SUMMARY: 'x', ANTHROPIC_API_KEY: 'k', SCORE_RETRY_DELAY_MS: '0' }
  let calls = 0
  globalThis.fetch = async () => ++calls === 1
    ? new Response('{"error":{"type":"overloaded_error"}}', { status: 529 })
    : new Response(JSON.stringify({ content: [{ text: '{"score": 75, "reason": "ok"}' }] }))
  assert.deepEqual(await scoreJob(env, {}), { score: 75, reason: 'ok' })
  assert.equal(calls, 2)

  calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{"error":{"type":"authentication_error"}}', { status: 401 }) }
  const r = await scoreJob(env, {})
  assert.equal(r.code, 'auth')
  assert.equal(calls, 1, 'auth errors are not retried')
})

test('all scoring failing: one alert per day per cause, with the cause', async () => {
  const w = world({ listings: [listing(1), listing(2)] })
  w.score = () => ({ http: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}' })
  await w.run(T0)
  await w.run(T0 + HOUR / 2)
  assert.equal(alerts(w).length, 1, 'not repeated every run')
  assert.ok(alerts(w)[0].includes('額度不足'))
  const h = JSON.parse(w.kv.get('health-v1'))
  assert.equal(h.lastScoreErrorCode, 'credit')
  assert.ok(!JSON.stringify(h).includes('test-key'), 'no secret in health record')
})

test('no alert when scoring works', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  assert.equal(alerts(w).length, 0)
})

test('daily report says clearly when every score failed', () => {
  const base = { date: '2026-10-19', runs: 48, added: 12, scored: 0, notified: 0, closed: 1,
    scoreFailed: 30, notifyFailed: 0, expired: 0, pending: 12 }
  const text = formatDailyReport({ ...base, lastScoreErrorCode: 'auth' })
  assert.ok(text.includes('今天評分全部失敗'))
  assert.ok(text.includes('API key 無效'))
  assert.ok(!text.includes('系統運作正常'))
  assert.ok(formatDailyReport({ ...base, scored: 10, scoreFailed: 0 }).includes('系統運作正常 ✅'))
})

test('daily scoring cap stops calls and is reported', async () => {
  const w = world({ listings: Array.from({ length: 10 }, (_, i) => listing(i)), vars: { SCORE_MAX_PER_DAY: '6' } })
  w.score = () => ({ score: 50, reason: 'meh' })
  const l1 = await w.run(T0)
  assert.equal(l1.scored, 6)
  assert.equal(l1.scoreCapped, true)
  const l2 = await w.run(T0 + HOUR / 2)
  assert.equal(l2.scored, 0, 'cap counts the whole day')
  assert.equal(w.calls.claude, 6)
  assert.equal(l2.pending, 4, 'capped jobs wait, not dropped')
})

test('seen-v1 is not rewritten when nothing changed', async () => {
  const w = world({ listings: [listing(1)] })
  await w.run(T0)
  let writes = 0
  const put = w.env.SEEN.put
  w.env.SEEN.put = async (k, v) => { if (k === 'seen-v1') writes++; return put(k, v) }
  await w.run(T0 + HOUR / 2)
  assert.equal(writes, 0)
  w.listings = [listing(1), listing(2)]
  await w.run(T0 + HOUR)
  assert.equal(writes, 1)
})

// ── HTTP endpoints ─────────────────────────────────────────

test('/api/status reports which secrets are set, never their values', async () => {
  const w = world({ listings: [listing(1)], vars: { WORKER_TOKEN: 'tok' } })
  await w.run(T0)
  const res = await worker.fetch(new Request('https://w.example.com/api/status',
    { headers: { Authorization: 'Bearer tok' } }), w.env)
  const body = await res.text()
  const data = JSON.parse(body)
  assert.equal(data.configured.ANTHROPIC_API_KEY, true)
  assert.equal(data.configured.RESUME_SUMMARY, true)
  for (const secret of ['test-key', 'test-token', 'sb-key', 'MS CS']) assert.ok(!body.includes(secret))
  const denied = await worker.fetch(new Request('https://w.example.com/api/status'), w.env)
  assert.equal(denied.status, 401)
})

test('/api/test-score makes exactly one call and returns the classified error', async () => {
  const w = world({ vars: { WORKER_TOKEN: 'tok' } })
  w.score = () => ({ http: 401, body: '{"type":"error","error":{"type":"authentication_error"}}' })
  globalThis.fetch = w.fetch
  const req = () => new Request('https://w.example.com/api/test-score',
    { method: 'POST', headers: { Authorization: 'Bearer tok' } })
  const r = await (await worker.fetch(req(), w.env)).json()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'auth')
  assert.equal(w.calls.claude, 1)
  w.score = () => ({ score: 88, reason: 'fine' })
  assert.deepEqual(await (await worker.fetch(req(), w.env)).json(), { ok: true, score: 88, reason: 'fine' })
  const denied = await worker.fetch(new Request('https://w.example.com/api/test-score', { method: 'POST' }), w.env)
  assert.equal(denied.status, 401)
})

test('extension endpoints still exist with the same auth', async () => {
  const w = world({ vars: { WORKER_TOKEN: 'tok' } })
  globalThis.fetch = w.fetch
  for (const [path, method] of [['/api/generate', 'POST'], ['/api/application', 'POST'], ['/api/summary', 'GET']]) {
    const res = await worker.fetch(new Request('https://w.example.com' + path, { method }), w.env)
    assert.equal(res.status, 401, path + ' requires the token')
  }
})

// ══ Added AI / ML sources (speedyapply AI, ML Newgrad, Agnikulu) ══════

// Fixture builders in each board's real layout (checked against the live files)
const AI_HEAD = '## 2027 USA AI New Graduate Positions\n\n### FAANG+\n\n' +
  '| Company | Position | Location | Salary | Posting | Age |\n|---|---|---|---|---|---|\n'
const AI_OTHER_HEAD = '\n### Other\n\n| Company | Position | Location | Posting | Age |\n|---|---|---|---|---|\n'
function aiRow({ company, title = 'Machine Learning Engineer', location = 'Seattle, WA', salary = '$180k/yr', url }) {
  const apply = `<a href="${url}"><img src="https://i.imgur.com/JpkfjIq.png" alt="Apply" width="70"/></a>`
  return `| <a href="https://www.${company.toLowerCase().replace(/\W/g, '')}.com"><strong>${company}</strong></a> | ${title} | ${location} | ` +
    (salary === null ? '' : `${salary} | `) + `${apply} | 3d |\n`
}
const aiMd = (rows, other = []) => AI_HEAD + rows.map(aiRow).join('') +
  AI_OTHER_HEAD + other.map(r => aiRow({ ...r, salary: null })).join('')

const ML_HEAD = '# ML New Grad 2027\n\n**3** open roles\n\n## 🆕 New this week\n\n' +
  '| Company | Role | Location | Posted | Apply |\n|---|---|---|---|---|\n'
const mlRow = ({ company, title = 'AI Engineer', location = 'Austin, TX', url }) =>
  `| **${company}** | ${title} | ${location} | **today** | [Apply](${url}) |\n`
const mlMd = rows => ML_HEAD + rows.map(mlRow).join('') + '\n## How this list is built\n\nProse, not a table.\n'

const agJson = rows => JSON.stringify(Object.fromEntries(rows.map(r => [r.url, {
  title: r.title ?? 'Applied Scientist', company: r.company, location: r.location ?? 'New York, NY',
  department: 'AI', category: 'frontier_ai', ats: 'greenhouse',
  education_levels: r.education_levels ?? ['New Grad'], is_us: r.is_us ?? true,
  posted_date: '2026-11-01', first_seen: '2026-11-01T00:00:00+00:00',
  last_seen: '2026-11-16T00:00:00+00:00', is_closed: r.is_closed ?? false,
}])))

const aiJob = i => ({ company: `AiCo ${i}`, url: `https://jobs.aico${i}.com/ml/${i}` })
const mlJob = i => ({ company: `MlCo ${i}`, url: `https://boards.greenhouse.io/mlco${i}/jobs/${i}` })
const agJob = i => ({ company: `AgCo ${i}`, url: `https://jobs.ashbyhq.com/agco${i}/${i}` })

// All five sources with history; seen-v1 already exists (normal mode, as in production)
function fiveSources(n = 3) {
  const ids = Array.from({ length: n }, (_, i) => i + 1)
  return world({
    listings: [listing(1)], speedy: '',
    speedyAi: aiMd(ids.map(aiJob)), mlNewgrad: mlMd(ids.map(mlJob)), agnikulu: agJson(ids.map(agJob)),
    seen: { ids: { 'sim-1': 1 }, urls: { 'https://jobs.example.com/1': 1 }, closed: {} },
  })
}
const sourceSeed = w => JSON.parse(w.kv.get('source-seed-v1') || '{}')

// ── Parsing ────────────────────────────────────────────────

test('speedyapply AI markdown: salary and application URL, with and without a salary column', () => {
  const md = aiMd([{ company: 'Google', title: 'Research Scientist - AI Safety', salary: '$196k/yr',
    url: 'https://www.google.com/about/careers/applications/jobs/results/1128' }],
  [{ company: 'Equinix', title: 'AI/Machine Learning Engineer', location: 'Dallas, TX +1',
    url: 'https://equinix.wd1.myworkdayjobs.com/en-US/external/job/AI-ML_JR-1' }])
  const { jobs, skipped } = parseSpeedyAiMarkdown(md)
  assert.equal(skipped, 0)
  assert.deepEqual(jobs, [
    { company: 'Google', title: 'Research Scientist - AI Safety', location: 'Seattle, WA',
      salary: '$196k/yr', url: 'https://www.google.com/about/careers/applications/jobs/results/1128' },
    { company: 'Equinix', title: 'AI/Machine Learning Engineer', location: 'Dallas, TX +1',
      salary: '', url: 'https://equinix.wd1.myworkdayjobs.com/en-US/external/job/AI-ML_JR-1' },
  ])
})

test('ML Newgrad markdown: [Apply](url) links, linked company names, escaped pipes', () => {
  const md = ML_HEAD +
    '| **[Ravelin](http://www.ravelin.com/)** | Junior Data Scientist | Remote | **2d** | [Apply](https://ravelin.pinpointhq.com/en/postings/f1ee) |\n' +
    '| **Selby Jennings** | Quantitative Researcher \\| NYC Hedge Fund | New York, NY | **4d** | [Apply](https://www.selbyjennings.com/en-us/job/qr-590576) |\n' +
    '\n## 🧪 AI Labs\n\n| Company | Role | Location | Posted | Apply |\n|---|---|---|---|---|\n' +
    '| **OpenAI** | Member of Technical Staff, Applied AI | San Francisco, CA | **5d** | [Apply](<https://jobs.ashbyhq.com/openai/abc>) |\n'
  const { jobs, skipped } = parseMlNewgradMarkdown(md)
  assert.equal(skipped, 0)
  assert.deepEqual(jobs.map(j => [j.company, j.title, j.location, j.url]), [
    ['Ravelin', 'Junior Data Scientist', 'Remote', 'https://ravelin.pinpointhq.com/en/postings/f1ee'],
    ['Selby Jennings', 'Quantitative Researcher | NYC Hedge Fund', 'New York, NY', 'https://www.selbyjennings.com/en-us/job/qr-590576'],
    ['OpenAI', 'Member of Technical Staff, Applied AI', 'San Francisco, CA', 'https://jobs.ashbyhq.com/openai/abc'],
  ])
})

test('Agnikulu JSON: open US jobs only; closed, non-US and PhD-only records excluded', () => {
  const { jobs, skipped } = parseAgnikuluJson(agJson([
    { company: 'Adobe', title: '2027 University Graduate - Machine Learning Engineer',
      location: 'San Jose', url: 'https://adobe.wd5.myworkdayjobs.com/job/MLE_R172085' },
    { company: 'Block', title: 'Data Scientist', is_closed: true, url: 'https://block.xyz/careers/jobs/52' },
    { company: 'Wayve', title: 'ML Engineer', is_us: false, url: 'https://wayve.ai/jobs/1' },
    { company: 'DeepLab', title: 'Research Scientist', education_levels: ['PhD'], url: 'https://deeplab.example.com/1' },
  ]))
  assert.equal(skipped, 0)
  assert.deepEqual(jobs, [{
    company: 'Adobe', title: '2027 University Graduate - Machine Learning Engineer', location: 'San Jose',
    salary: '', url: 'https://adobe.wd5.myworkdayjobs.com/job/MLE_R172085', category: 'frontier_ai', degrees: 'New Grad',
  }])
})

test('unsafe or malformed application URLs are skipped and counted', () => {
  for (const bad of ['http://jobs.example.com/1', 'javascript:alert(1)', 'https://go.vansh.nyc/1A4',
    'https://bit.ly/x', 'https://user:pw@jobs.example.com/1', 'https://localhost/x', 'https://10.0.0.1/x',
    'https://jobs.example.com:8443/x', 'https://jobs.example.com/a b', 'https://x.example.com/"><script>',
    '', 'not a url', null, 42]) {
    assert.equal(safeApplyUrl(bad), null, `rejects ${bad}`)
  }
  assert.equal(safeApplyUrl(' https://jobs.lever.co/acme/123?lever-origin=x '), 'https://jobs.lever.co/acme/123?lever-origin=x')

  const ml = parseMlNewgradMarkdown(mlMd([
    { company: 'Microsoft', title: 'Applied Sciences', url: 'https://go.vansh.nyc/1A4' },
    { company: 'Evil', title: 'AI Engineer', url: 'javascript:alert(1)' },
    { company: 'Good', title: 'AI Engineer', url: 'https://jobs.good.com/1' },
  ]) + '| **NoLink** | ML Engineer | Remote | **1d** | Closed |\n')
  assert.deepEqual(ml.jobs.map(j => j.company), ['Good'])
  assert.equal(ml.skipped, 2, 'shortener + javascript: (the last row is outside any table)')

  const ai = parseSpeedyAiMarkdown(aiMd([{ company: 'Plain', url: 'http://plain.example.com/1' },
    { company: 'Ok', url: 'https://ok.example.com/1' }]))
  assert.deepEqual(ai.jobs.map(j => j.company), ['Ok'])
  assert.equal(ai.skipped, 1)

  const ag = parseAgnikuluJson(JSON.stringify({
    'http://block.xyz/careers/jobs/5214784008': { title: 'ML Engineer', company: 'Block', is_us: true, is_closed: false },
    'https://ok.example.com/2': { title: 'ML Engineer', company: 'Ok', is_us: true, is_closed: false },
    'https://bad.example.com/3': { title: 42, company: 'Bad' },
  }))
  assert.deepEqual(ag.jobs.map(j => j.company), ['Ok'])
  assert.equal(ag.skipped, 2)
})

test('malformed documents throw; valid empty documents do not', () => {
  assert.throws(() => parseSpeedyAiMarkdown('<html>rate limited</html>'), /unrecognized format/)
  assert.throws(() => parseMlNewgradMarkdown('# ML New Grad 2027\n\nNo tables today.'), /unrecognized format/)
  assert.throws(() => parseAgnikuluJson('{"truncated": '), /invalid JSON/)
  assert.throws(() => parseAgnikuluJson('"just a string"'), /unrecognized format/)
  assert.deepEqual(parseSpeedyAiMarkdown(aiMd([])), { jobs: [], skipped: 0 })
  assert.deepEqual(parseMlNewgradMarkdown(mlMd([])), { jobs: [], skipped: 0 })
  assert.deepEqual(parseAgnikuluJson('{}'), { jobs: [], skipped: 0 })
})

// ── Title matching ─────────────────────────────────────────

test('AI/ML titles are recognized; senior, intern, PhD-only and non-technical roles are not', () => {
  for (const t of ['AI Engineer', 'Applied AI Engineer', 'Machine Learning Engineer', 'ML Engineer',
    'LLM Engineer', 'Generative AI Engineer', 'Applied Scientist', 'Applied Scientist II', 'NLP Engineer',
    'AI Software Engineer', 'Software Engineer — Machine Learning', 'Member of Technical Staff',
    'Research Scientist - AI Safety', 'Applied Sciences', 'Computer Vision Researcher', 'GenAI Specialist',
    'Software Engineer, New Grad (BS/MS/PhD)', 'Software Engineer III']) {
    assert.equal(matchesKeywords(t), true, `admits "${t}"`)
  }
  for (const t of ['Senior Machine Learning Engineer', 'Staff AI Engineer', 'Principal Applied Scientist',
    'Director of AI', 'Machine Learning Intern', 'ML Engineer Internship', 'PhD Research Scientist - Generative AI',
    'Machine Learning Engineer Graduate - 2027 Start - PhD', 'Postdoctoral Researcher, AI',
    'Head of AI Platform', 'VP, Machine Learning', 'ML Engineer (5+ years)', 'AI Trainer - Writing',
    'AI Sales Representative', 'Senior Member of Technical Staff', 'Equity Research Associate', 'Account Executive']) {
    assert.equal(matchesKeywords(t), false, `rejects "${t}"`)
  }
})

// ── Silent baseline per source (source-seed-v1) ────────────

test('first successful crawl of each new source: jobs remembered, nothing scored or sent', async () => {
  const w = fiveSources(3)
  const log = await w.run(T0)
  assert.equal(log.mode, 'normal')
  assert.equal(log.queued, 0)
  assert.equal(log.seeded, 9)
  assert.equal(w.calls.claude, 0, 'historical jobs are not scored')
  assert.equal(w.calls.telegram, 0, 'no Telegram message at all')
  assert.deepEqual(Object.keys(w.pending().jobs), [])
  assert.deepEqual(Object.keys(sourceSeed(w)).sort(), ['agnikulu', 'ml-newgrad', 'speedyapply-ai'])
  for (const s of ['speedyapply-ai', 'ml-newgrad', 'agnikulu']) assert.equal(log.sources[s].status, 'seeded')
  const seen = JSON.parse(w.kv.get('seen-v1'))
  assert.equal(seen.urls['https://jobs.aico1.com/ml/1'], 1)
  assert.deepEqual(Object.keys(seen).sort(), ['closed', 'ids', 'urls'], 'seen-v1 keeps its shape')
  assert.deepEqual(w.calls.other, [], 'no application URL was fetched')

  const again = await w.run(T0 + HOUR / 2)
  assert.equal(again.queued, 0)
  assert.equal(w.calls.claude, 0)
})

test('after the baseline, newly added jobs from each source are scored and sent', async () => {
  const w = fiveSources(3)
  await w.run(T0)
  w.speedyAi = aiMd([1, 2, 3, 4].map(aiJob).map((j, i) => i === 3 ? { ...j, salary: '$201k/yr' } : j))
  w.mlNewgrad = mlMd([1, 2, 3, 4].map(mlJob))
  w.agnikulu = agJson([1, 2, 3, 4].map(agJob))
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.queued, 3)
  assert.equal(log.scored, 3)
  assert.equal(log.notified, 3)
  assert.deepEqual(matches(w).map(m => m.split('\n')[1]).sort(), [
    '<b>85/100</b> — AgCo 4 — Applied Scientist',
    '<b>85/100</b> — AiCo 4 — Machine Learning Engineer',
    '<b>85/100</b> — MlCo 4 — AI Engineer',
  ])
  assert.ok(matches(w).some(m => m.includes('Seattle, WA｜$201k/yr')), 'salary kept in the message')
  assert.ok(w.prompts.some(p => p.includes('Degrees: New Grad')), 'Agnikulu education levels reach the prompt')
  assert.equal(log.sources['ml-newgrad'].added, 1)
})

test('existing Simplify and speedyapply SWE sources work unchanged next to the new ones', async () => {
  const w = fiveSources(2)
  w.listings = [listing(1), listing(2)]
  w.speedy = '| Speedy Co | Software Engineer | Austin, TX | $150k | <a href="https://speedy.example.com/1">Apply</a> | 1d |\n'
  const log = await w.run(T0)
  assert.equal(log.simplify, 2)
  assert.equal(log.speedy, 1)
  assert.equal(log.queued, 2, 'Simplify + speedyapply SWE new jobs, none from the baselined sources')
  assert.equal(matches(w).length, 2)
  assert.equal(Object.keys(w.pending().jobs).length, 0, 'queue drained')
})

test('the same job URL on several sources is queued and scored once', async () => {
  const w = fiveSources(1)
  await w.run(T0)
  const shared = { company: 'Shared AI', url: 'https://jobs.lever.co/shared/1' }
  w.speedyAi = aiMd([aiJob(1), { ...shared, title: 'ML Engineer' }])
  w.mlNewgrad = mlMd([mlJob(1), { ...shared, title: 'ML Engineer', url: shared.url + '?utm_source=mlnewgrad' }])
  w.agnikulu = agJson([agJob(1), { ...shared, title: 'ML Engineer', url: shared.url + '/' }])
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.queued, 1)
  assert.equal(w.calls.claude, 1)
  assert.equal(matches(w).length, 1)
  await w.run(T0 + HOUR)
  assert.equal(w.calls.claude, 1, 'not queued again on the next crawl')
})

test('one role under different URLs on different sources: one Telegram message', async () => {
  const w = fiveSources(1)
  await w.run(T0)
  const role = { company: 'Acme AI', title: 'Machine Learning Engineer', location: 'Austin, TX' }
  w.speedyAi = aiMd([aiJob(1), { ...role, url: 'https://acme.wd1.myworkdayjobs.com/job/MLE_R1' }])
  w.mlNewgrad = mlMd([mlJob(1), { ...role, url: 'https://jobs.ashbyhq.com/acme/mle' }])
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.queued, 1)
  assert.equal(log.duplicates, 1)
  assert.equal(matches(w).length, 1)
  w.agnikulu = agJson([agJob(1), { ...role, url: 'https://boards.greenhouse.io/acme/jobs/9' }])
  await w.run(T0 + HOUR)
  assert.equal(matches(w).length, 1, 'still one message when it shows up again later')
})

test('a source returning HTTP 500 does not block the others and is baselined once it recovers', async () => {
  const w = fiveSources(2)
  w.sourceStatus.mlNewgrad = 500
  w.listings = [listing(1), listing(2)]
  const log = await w.run(T0)
  assert.equal(log.sources['ml-newgrad'].status, 'failed')
  assert.equal(log.sources['speedyapply-ai'].status, 'seeded')
  assert.equal(log.sources.agnikulu.status, 'seeded')
  assert.equal(log.queued, 1, 'Simplify still works')
  assert.ok(!('ml-newgrad' in sourceSeed(w)), 'failed source is not marked baselined')

  delete w.sourceStatus.mlNewgrad
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.sources['ml-newgrad'].status, 'seeded')
  assert.equal(log2.queued, 0, 'its history is still not treated as new')
  assert.equal(w.calls.claude, 1)
})

test('malformed data never marks a source as baselined', async () => {
  const w = fiveSources(2)
  w.speedyAi = '<html><body>Rate limit exceeded</body></html>'
  w.mlNewgrad = mlMd([]).replace(/\| Company \| Role[^\n]*\n/, '')   // header gone: format changed
  w.agnikulu = agJson([1, 2].map(agJob)).slice(0, 80)               // truncated JSON
  const log = await w.run(T0)
  for (const s of ['speedyapply-ai', 'ml-newgrad', 'agnikulu']) {
    assert.equal(log.sources[s].status, 'failed', s)
  }
  assert.equal(w.kv.has('source-seed-v1'), false)

  // a table whose every row is unusable is malformed too, not "empty"
  w.speedyAi = aiMd([1, 2].map(i => ({ ...aiJob(i), url: 'https://go.vansh.nyc/' + i })))
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.sources['speedyapply-ai'].status, 'failed')
  assert.equal(w.kv.has('source-seed-v1'), false)

  // once the data is valid again: silent baseline, not a flood
  w.speedyAi = aiMd([1, 2].map(aiJob))
  w.mlNewgrad = mlMd([1, 2].map(mlJob))
  w.agnikulu = agJson([1, 2].map(agJob))
  const log3 = await w.run(T0 + HOUR)
  assert.equal(log3.seeded, 6)
  assert.equal(log3.queued, 0)
  assert.equal(w.calls.claude, 0)
})

test('empty but valid datasets are "empty", not failures, and do not baseline the source', async () => {
  const w = fiveSources(0)
  const log = await w.run(T0)
  for (const s of ['speedyapply-ai', 'ml-newgrad', 'agnikulu']) {
    assert.equal(log.sources[s].status, 'empty', s)
    assert.equal(log.sources[s].error, undefined)
  }
  assert.equal(w.kv.has('source-seed-v1'), false)
  // jobs appear later: that first non-empty crawl is the silent baseline
  w.speedyAi = aiMd([1, 2].map(aiJob))
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.sources['speedyapply-ai'].status, 'seeded')
  assert.equal(log2.queued, 0)
  // a baselined source that becomes empty stays baselined and is fine
  w.speedyAi = aiMd([])
  const log3 = await w.run(T0 + HOUR)
  assert.equal(log3.sources['speedyapply-ai'].status, 'ok')
  assert.ok('speedyapply-ai' in sourceSeed(w))
})

// ── KV failures never cause a flood ─────────────────────────

test('source-seed-v1 unreadable: the new sources are skipped, nothing queued or marked', async () => {
  const w = fiveSources(3)
  w.failKvGet = 'source-seed-v1'
  const log = await w.run(T0)
  for (const s of ['speedyapply-ai', 'ml-newgrad', 'agnikulu']) assert.equal(log.sources[s].status, 'skipped')
  assert.equal(log.queued, 0)
  assert.equal(w.calls.sources.speedyAi, undefined, 'not even fetched')
  assert.equal(JSON.parse(w.kv.get('seen-v1')).urls['https://jobs.aico1.com/ml/1'], undefined)
  w.failKvGet = null
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.seeded, 9)
  assert.equal(log2.queued, 0)
})

test('seen-v1 write fails during a baseline: source not marked, re-baselined silently next run', async () => {
  const w = fiveSources(3)
  w.failKvPut = 'seen-v1'
  await assert.rejects(w.run(T0))
  assert.equal(w.kv.has('source-seed-v1'), false, 'never marked before its jobs are in seen-v1')
  w.failKvPut = null
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.seeded, 9)
  assert.equal(log.queued, 0)
  assert.equal(w.calls.claude, 0)
  assert.equal(w.calls.telegram, 0)
})

test('source-seed-v1 write fails: the run continues and the next run re-baselines silently', async () => {
  const w = fiveSources(3)
  w.listings = [listing(1), listing(2)]
  w.failKvPut = 'source-seed-v1'
  const log = await w.run(T0)
  assert.equal(log.queued, 1, 'Simplify job still processed')
  assert.equal(matches(w).length, 1)
  w.failKvPut = null
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.queued, 0)
  assert.equal(w.calls.claude, 1, 'no historical job scored')
  assert.deepEqual(Object.keys(sourceSeed(w)).sort(), ['agnikulu', 'ml-newgrad', 'speedyapply-ai'])
})

test('corrupt source-seed-v1: sources re-baselined silently', async () => {
  const w = fiveSources(2)
  w.kv.set('source-seed-v1', '{not json')
  const log = await w.run(T0)
  assert.equal(log.seeded, 6)
  assert.equal(log.queued, 0)
  assert.equal(w.calls.claude, 0)
})

test('baselined source that suddenly reports a wall of unseen jobs is absorbed, not sent', async () => {
  const w = fiveSources(60)
  await w.run(T0)
  // same 60 jobs, every URL changed (e.g. the board switched link format)
  w.agnikulu = agJson(Array.from({ length: 60 }, (_, i) => ({ ...agJob(i + 1), url: `https://new.example.com/${i}` })))
  const log = await w.run(T0 + HOUR / 2)
  assert.equal(log.sources.agnikulu.status, 'reseeded')
  assert.equal(log.queued, 0)
  assert.equal(w.calls.claude, 0)
  // a normal trickle afterwards still flows through
  w.agnikulu = agJson([...Array.from({ length: 60 }, (_, i) => ({ ...agJob(i + 1), url: `https://new.example.com/${i}` })), agJob(99)])
  const log2 = await w.run(T0 + HOUR)
  assert.equal(log2.queued, 1)
})

test('first run ever (no seen-v1) also baselines the new sources silently', async () => {
  const w = fiveSources(2)
  w.kv.delete('seen-v1')
  const log = await w.run(T0)
  assert.equal(log.mode, 'seed')
  assert.equal(w.calls.claude, 0)
  assert.equal(matches(w).length, 0)
  assert.deepEqual(Object.keys(sourceSeed(w)).sort(), ['agnikulu', 'ml-newgrad', 'speedyapply-ai'])
  const log2 = await w.run(T0 + HOUR / 2)
  assert.equal(log2.queued, 0)
})

test('five sources stay within the subrequest budget with a large backlog', async () => {
  const w = fiveSources(3)
  await w.run(T0)
  w.listings = Array.from({ length: 200 }, (_, i) => listing(i + 10))
  w.score = () => ({ score: 95, reason: 'great' })
  const before = w.calls.total
  await w.run(T0 + HOUR / 2)
  const used = w.calls.total - before
  assert.ok(used <= 48, `used ${used} subrequests`)
  assert.equal(matches(w).length, 10, 'notify cap respected; rest wait')
})

test('/api/status shows which added sources are baselined, without secrets', async () => {
  const w = fiveSources(1)
  w.env.WORKER_TOKEN = 'tok'
  await w.run(T0)
  const res = await worker.fetch(new Request('https://w.example.com/api/status',
    { headers: { Authorization: 'Bearer tok' } }), w.env)
  const data = await res.json()
  assert.deepEqual(Object.keys(data.sourceSeed).sort(), ['agnikulu', 'ml-newgrad', 'speedyapply-ai'])
  assert.ok(!JSON.stringify(data).includes('sb-key'))
})
