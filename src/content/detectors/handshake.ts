import type { JobInfo } from '../../shared/types'

export function detectHandshake(): JobInfo | null {
  const title =
    document.querySelector('h1[data-hook="job-name"]')?.textContent?.trim() ||
    document.querySelector('h1.job-name')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim() || ''

  const company =
    document.querySelector('[data-hook="employer-name"]')?.textContent?.trim() ||
    document.querySelector('.employer-name')?.textContent?.trim() ||
    document.querySelector('a[data-hook="employer-link"]')?.textContent?.trim() || ''

  const location =
    document.querySelector('[data-hook="job-location"]')?.textContent?.trim() ||
    document.querySelector('.job-location')?.textContent?.trim() || ''

  const descEl =
    document.querySelector('[data-hook="job-description"]') ||
    document.querySelector('.job-description') ||
    document.querySelector('[class*="description"]')

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
    source: 'handshake',
  }
}
