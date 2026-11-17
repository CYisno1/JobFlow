// Read-only live check of the three added job-board sources.
// Fetches the public raw GitHub files and runs the Worker's parsers on them.
// No KV, Supabase, Telegram, Anthropic or Cloudflare calls; no credentials.
// Not part of `npm test` (network). Run: node worker/test/sources.smoke.mjs

import { extraSources, matchesKeywords, normalizeUrl } from '../src/index.js'

let failed = 0
for (const src of extraSources()) {
  try {
    const res = await fetch(src.url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const text = await res.text()
    const t = performance.now()
    const { jobs, skipped } = src.parse(text)
    const ms = (performance.now() - t).toFixed(1)
    const relevant = jobs.filter(j => matchesKeywords(j.title))
    const unique = new Set(relevant.map(j => normalizeUrl(j.url))).size
    console.log(`${src.name}: ${(text.length / 1024).toFixed(0)} KB, parsed ${jobs.length}, ` +
      `skipped ${skipped}, relevant ${relevant.length} (${unique} unique URLs), parse ${ms} ms`)
    if (jobs.length === 0) console.log(`  WARNING: ${src.name} returned no jobs`)
  } catch (e) {
    failed++
    console.log(`${src.name}: FAILED — ${e && e.message}`)
  }
}
process.exitCode = failed ? 1 : 0
