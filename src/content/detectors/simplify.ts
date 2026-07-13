import type { JobInfo } from '../../shared/types'

export function detectSimplify(): JobInfo | null {
  const title =
    document.querySelector('h1[class*="title"]')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim() || ''

  const company =
    document.querySelector('[class*="company"]')?.textContent?.trim() ||
    document.querySelector('[class*="employer"]')?.textContent?.trim() || ''

  const location =
    document.querySelector('[class*="location"]')?.textContent?.trim() || ''

  const descEl =
    document.querySelector('[class*="description"]') ||
    document.querySelector('[class*="job-detail"]') ||
    document.querySelector('main')

  const descriptionRaw = descEl?.textContent?.trim() || ''

  if (!title || !descriptionRaw) return null

  return {
    id: btoa(`${company}-${title}-${window.location.href}`).slice(0, 32),
    url: window.location.href,
    company: company || 'Unknown Company',
    title,
    location,
    descriptionRaw,
    detectedAt: new Date().toISOString(),
    source: 'simplify',
  }
}
