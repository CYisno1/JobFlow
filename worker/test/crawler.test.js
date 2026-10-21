// Worker crawler / scoring / Telegram tests. No network, no credentials:
// fetch and KV are replaced with in-memory fakes.
// Run: npm test (from the repo root)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCrawler, scoreJob, pickForScoring, formatMatch, matchKey, workerConfig,
  classifyScoreError, formatDailyReport,
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

// In-memory world: KV, GitHub sources, Claude, Telegram, Supabase
function world({ listings = [], speedy = '', seen = { ids: {}, urls: {}, closed: {} }, vars = {} } = {}) {
  const kv = new Map()
  if (seen) kv.set('seen-v1', JSON.stringify(seen))
  const w = {
    kv, listings, speedy,
    score: () => ({ score: 85, reason: 'Good fit.' }),   // per-job behaviour, by company
    telegramOk: () => true,
    failKvPut: null,
    calls: { claude: 0, telegram: 0, supabase: 0, total: 0 },
    messages: [],
    prompts: [],
  }
  w.env = {
    SEEN: {
      get: async k => kv.get(k) ?? null,
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
    if (url.includes('listings.json')) return new Response(JSON.stringify(w.listings))
    if (url.includes('NEW_GRAD_USA.md')) return new Response(w.speedy)
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
