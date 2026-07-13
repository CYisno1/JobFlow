import { getProfile, addApplication } from '../shared/storage'
import { generateCoverLetter, hasWorkerConfig } from './resume-generator'
import type { JobInfo } from '../shared/types'

// Crawling, scoring and notifications all live in the Cloudflare Worker;
// this background script only handles generation requests and submission logging.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[JobFlow] Installed')
})

// ── Message routing ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id

  if (message.type === 'GENERATE_COVER_LETTER') {
    if (!tabId) return true
    handleCoverLetter(tabId, message.job)
    return true
  }

  // Content script detected a successful submission → record it
  if (message.type === 'APPLICATION_SUBMITTED') {
    handleApplicationSubmitted(message.job as JobInfo)
    sendResponse({ ok: true })
    return true
  }

  return true
})

// ── Submission detected: local record + report to the ledger ──
async function handleApplicationSubmitted(job: JobInfo) {
  // 1. Local record (shows up in the popup immediately)
  await addApplication({
    id: `app-${job.id ?? Date.now()}`,
    job,
    customizedResume: '',
    appliedAt: new Date().toISOString(),
    status: 'submitted',
  })

  // 2. Report via the Worker (writes Supabase + forwards to the Sheet)
  const profile = await getProfile()
  // Grab sheetsId before the guard: its else branch narrows profile to null
  // (the predicate asserts more than "config missing")
  const sheetUrl = profile?.sheetsId
  if (hasWorkerConfig(profile)) {
    fetch(`${profile.workerUrl.trim().replace(/\/+$/, '')}/api/application`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${profile.workerToken.trim()}`,
      },
      body: JSON.stringify({
        company: job.company,
        title: job.title,
        url: job.url,
      }),
    }).catch(() => {})   // reporting failure never blocks the local record
  } else if (sheetUrl) {
    // Fallback: no Worker configured → post to Apps Script directly
    fetch(sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'application',
        company: job.company,
        title: job.title,
        url: job.url,
      }),
    }).catch(() => {})
  }

  // 3. Desktop notification so the user knows it was recorded
  chrome.notifications.create(`submitted-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: '✓ 已記錄投遞',
    message: `${job.company} — ${job.title}`,
    priority: 0,
  })
}

async function handleCoverLetter(tabId: number, job: any) {
  const profile = await getProfile()
  if (!hasWorkerConfig(profile)) {
    chrome.tabs.sendMessage(tabId, { type: 'COVER_LETTER_ERROR', error: '請先在設定頁填入 Worker 網址和 Token' })
    return
  }
  // Keep the service worker alive during long generations
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000)
  try {
    let accumulated = ''
    await generateCoverLetter(profile, job, (chunk) => {
      accumulated += chunk
      chrome.tabs.sendMessage(tabId, { type: 'COVER_LETTER_CHUNK', accumulated })
    })
    chrome.tabs.sendMessage(tabId, { type: 'COVER_LETTER_READY', coverLetter: accumulated })
  } catch (err: any) {
    chrome.tabs.sendMessage(tabId, { type: 'COVER_LETTER_ERROR', error: err?.message ?? '生成求職信失敗' })
  } finally {
    clearInterval(keepAlive)
  }
}
