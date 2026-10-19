// Worker crawler / scoring / Telegram tests. No network, no credentials:
// fetch and KV are replaced with in-memory fakes.
// Run: npm test (from the repo root)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCrawler, scoreJob, pickForScoring, formatMatch, matchKey, workerConfig,
} from '../src/index.js'

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
      if (r.http) return new Response('upstream error', { status: r.http })
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
  assert.equal(w.calls.claude, 2, 'stops after 2 consecutive API failures')
  assert.equal(log.scoreFailed, 2)
  assert.equal(w.calls.telegram, 0, 'no unscored recommendations')
  assert.equal(Object.keys(w.pending().jobs).length, 5)
})

test('missing RESUME_SUMMARY: nothing is sent unscored', async () => {
  const w = world({ listings: [listing(1)], vars: { RESUME_SUMMARY: '' } })
  const log = await w.run(T0)
  assert.equal(log.scoreFailed >= 1, true)
  assert.equal(w.calls.claude, 0)
  assert.equal(w.calls.telegram, 0)
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
  assert.equal(w.calls.telegram, 0)
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
  assert.deepEqual(workerConfig({}), { threshold: 70, scoreMax: 20, notifyMax: 10 })
  assert.deepEqual(workerConfig({ SCORE_THRESHOLD: '250', SCORE_MAX_PER_RUN: 'x', NOTIFY_MAX_PER_RUN: '-3' }),
    { threshold: 100, scoreMax: 20, notifyMax: 0 })
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
  const env = { RESUME_SUMMARY: 'x', ANTHROPIC_API_KEY: 'k' }
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
