import type { JobInfo } from '../../shared/types'

export function detectLinkedIn(): JobInfo | null {
  // ── Job title (many fallbacks; LinkedIn renames classes often) ──
  const title = queryText([
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title',
    'h1.t-24',
    'h1.jobs-details-top-card__job-title',
    '.topcard__title',
    'h1',
  ])

  // ── Company ──────────────────────────────────────────────
  const company = queryText([
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    '.topcard__flavor--black-link',
    'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
  ])

  // ── Location ─────────────────────────────────────────────
  const location = queryText([
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    '.jobs-details-top-card__bullet',
    'span.tvm__text:first-of-type',
  ])

  // ── JD body ───────────────────────────────────────────────
  const descEl =
    document.querySelector('.jobs-description__content') ||
    document.querySelector('.jobs-box__html-content') ||
    document.querySelector('#job-details') ||
    document.querySelector('.jobs-description') ||
    document.querySelector('[class*="jobs-description"]') ||
    document.querySelector('.description__text') ||
    document.querySelector('.show-more-less-html__markup')

  const descriptionRaw = descEl?.textContent?.trim() || ''

  // No title → give up
  if (!title) return null

  return {
    id: btoa(`${company}-${title}-${window.location.href}`).slice(0, 32),
    url: window.location.href,
    company: company || extractCompanyFromUrl(),
    title,
    location,
    descriptionRaw,
    detectedAt: new Date().toISOString(),
    source: 'linkedin',
  }
}

// First selector with text wins
function queryText(selectors: string[]): string {
  for (const sel of selectors) {
    const text = document.querySelector(sel)?.textContent?.trim()
    if (text) return text
  }
  return ''
}

// URL fallback：linkedin.com/jobs/view/title-at-company-123
function extractCompanyFromUrl(): string {
  const match = window.location.pathname.match(/\/jobs\/view\/(.+?)-\d+/)
  if (!match) return 'Unknown Company'
  const parts = match[1].split('-at-')
  return parts.length > 1
    ? parts[parts.length - 1].replace(/-/g, ' ')
    : ''
}
