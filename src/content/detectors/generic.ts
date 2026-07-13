import type { JobInfo } from '../../shared/types'

// JSON-LD schema.org/JobPosting is the most stable source (many career sites embed it)
function extractFromJsonLd(): Partial<JobInfo> | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || '')
      const job = Array.isArray(data) ? data.find((d: any) => d['@type'] === 'JobPosting') : data
      if (job?.['@type'] === 'JobPosting') {
        return {
          title: job.title || '',
          company: job.hiringOrganization?.name || '',
          location: job.jobLocation?.address?.addressLocality || '',
          descriptionRaw: job.description?.replace(/<[^>]+>/g, ' ').trim() || '',
        }
      }
    } catch { /* ignore malformed JSON */ }
  }
  return null
}

export function detectGeneric(): JobInfo | null {
  // 1. Try JSON-LD
  const fromJsonLd = extractFromJsonLd()

  // 2. heuristic fallback
  const title =
    fromJsonLd?.title ||
    document.querySelector('h1')?.textContent?.trim() || ''

  const company =
    fromJsonLd?.company ||
    document.querySelector('[class*="company"]')?.textContent?.trim() ||
    document.title.split(/[-|@]/)[0]?.trim() || ''

  const location =
    fromJsonLd?.location ||
    document.querySelector('[class*="location"]')?.textContent?.trim() || ''

  // Longest text block is usually the JD
  const descriptionRaw =
    fromJsonLd?.descriptionRaw ||
    findLongestTextBlock()

  if (!title || !descriptionRaw || descriptionRaw.length < 100) return null

  return {
    id: btoa(`${company}-${title}-${window.location.href}`).slice(0, 32),
    url: window.location.href,
    company: company || document.location.hostname,
    title,
    location,
    descriptionRaw,
    detectedAt: new Date().toISOString(),
    source: 'generic',
  }
}

function findLongestTextBlock(): string {
  const candidates = [
    // ATS-specific
    '[data-automation-id="jobPostingDescription"]',   // Workday
    '[data-automation-id="job-description"]',
    '.job-post-description',                          // Greenhouse
    '#content .section',                              // Greenhouse boards
    '.section-wrapper .section',                      // Lever
    '[class*="ashby-job-posting"]',                   // Ashby
    '[class*="job-description"]', '[class*="jobDescription"]',
    '[id*="job-description"]',   '[id*="jobDescription"]',
    // generic
    'article', 'main',
    '[class*="description"]', '[id*="description"]',
    '[class*="posting"]',     '[class*="job-detail"]',
    '[class*="job-content"]', '[class*="job-body"]',
    'section',
  ]
  let longest = ''
  for (const selector of candidates) {
    document.querySelectorAll(selector).forEach(el => {
      const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ''
      if (text.length > longest.length) longest = text
    })
  }
  // Fallback: scan the body (minus nav/header/footer)
  if (longest.length < 300) {
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll('nav, header, footer, script, style, [role="navigation"]').forEach(el => el.remove())
    longest = clone.innerText?.trim() ?? ''
  }
  return longest.slice(0, 10000)
}
