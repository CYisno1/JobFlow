import type { JobInfo } from '../../shared/types'

export function detectIndeed(): JobInfo | null {
  const title =
    document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ||
    document.querySelector('h1.jobsearch-JobInfoHeader-title')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim() || ''

  const company =
    document.querySelector('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ||
    document.querySelector('.jobsearch-CompanyInfoContainer a')?.textContent?.trim() ||
    document.querySelector('[data-company-name]')?.textContent?.trim() || ''

  const location =
    document.querySelector('[data-testid="job-location"]')?.textContent?.trim() ||
    document.querySelector('.jobsearch-JobInfoHeader-subtitle > div:last-child')?.textContent?.trim() || ''

  const descEl =
    document.querySelector('#jobDescriptionText') ||
    document.querySelector('.jobsearch-jobDescriptionText')

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
    source: 'indeed',
  }
}
