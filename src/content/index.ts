import { detectLinkedIn }  from './detectors/linkedin'
import { detectIndeed }    from './detectors/indeed'
import { detectSimplify }  from './detectors/simplify'
import { detectHandshake } from './detectors/handshake'
import { detectGeneric }   from './detectors/generic'
import { tryAutoFill, tryAutoUploadResume } from './ats-filler'
import type { JobInfo } from '../shared/types'

const SIDEBAR_ID = 'resume-helper-sidebar'

// ── Detect the platform and extract the JD ────────────────
function detectJob(): JobInfo | null {
  const host = window.location.hostname
  const path = window.location.pathname

  if (host.includes('linkedin.com'))    return detectLinkedIn()
  if (host.includes('indeed.com'))      return detectIndeed()
  if (host.includes('simplify.jobs'))   return detectSimplify()
  if (host.includes('joinhandshake.com')) return detectHandshake()
  // GitHub job-list pages: notify the SW but skip the sidebar (list, not one job)
  if (host === 'github.com' && (path.includes('Internship') || path.includes('jobs') || path.includes('New-Grad'))) {
    notifyGithubPage()
    return null
  }
  return detectGeneric()
}

// Tell the SW we're on a GitHub list page
function notifyGithubPage() {
  chrome.runtime.sendMessage({ type: 'GITHUB_LIST_PAGE', url: window.location.href })
}

// ── Sidebar ───────────────────────────────────────────────
function injectSidebar(job: JobInfo) {
  if (document.getElementById(SIDEBAR_ID)) return   // already injected

  const wrapper = document.createElement('div')
  wrapper.id = SIDEBAR_ID
  wrapper.style.cssText = `
    position: fixed; top: 0; right: 0; width: 420px; height: 100vh;
    z-index: 2147483647; border: none; background: transparent;
  `

  const iframe = document.createElement('iframe')
  iframe.src = chrome.runtime.getURL('src/sidebar/index.html')
  iframe.style.cssText = 'width:100%; height:100%; border:none;'
  iframe.allow = 'clipboard-write'

  wrapper.appendChild(iframe)
  document.body.appendChild(wrapper)

  // Send the job info once the iframe loads
  iframe.onload = () => {
    iframe.contentWindow?.postMessage({ type: 'INIT', job }, '*')
  }
}

function removeSidebar() {
  document.getElementById(SIDEBAR_ID)?.remove()
}

// ── Messages from the service worker ──────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OPEN_SIDEBAR' && msg.job) {
    injectSidebar(msg.job as JobInfo)
  }
  const iframe = () => document.querySelector(`#${SIDEBAR_ID} iframe`) as HTMLIFrameElement | null
  if (msg.type === 'COVER_LETTER_CHUNK') {
    iframe()?.contentWindow?.postMessage({ type: 'COVER_LETTER_CHUNK', accumulated: msg.accumulated }, '*')
  }
  if (msg.type === 'COVER_LETTER_READY') {
    iframe()?.contentWindow?.postMessage({ type: 'COVER_LETTER_READY', coverLetter: msg.coverLetter }, '*')
  }
  if (msg.type === 'COVER_LETTER_ERROR') {
    iframe()?.contentWindow?.postMessage({ type: 'COVER_LETTER_ERROR', error: msg.error }, '*')
  }
})

// ── Messages from the sidebar iframe ──────────────────────
window.addEventListener('message', (event) => {
  if (!event.data?.type) return

  if (event.data.type === 'SIDEBAR_CLOSE') removeSidebar()
  if (event.data.type === 'FILL_FORM') tryAutoFill()
  if (event.data.type === 'UPLOAD_ORIGINAL_PDF') tryAutoUploadResume()

  // Minimize / expand: resize the wrapper into a slim right-edge tab
  if (event.data.type === 'SIDEBAR_MINIMIZE') {
    const el = document.getElementById(SIDEBAR_ID)
    if (el) el.style.width = '36px'
  }
  if (event.data.type === 'SIDEBAR_EXPAND') {
    const el = document.getElementById(SIDEBAR_ID)
    if (el) el.style.width = '420px'
  }

  if (event.data.type === 'GENERATE_COVER_LETTER') {
    chrome.runtime.sendMessage({ type: 'GENERATE_COVER_LETTER', job: event.data.job })
  }
})

// ── Submission detection: auto-record applications ────────
// Every ATS shows a fixed confirmation page after submitting: the URL contains
// confirmation/thank-you, or the body says "Thank you for applying" etc.
// On detection, notify the service worker to record the application.
// Workday is excluded: this script never runs there (manifest exclude_matches)
const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'applytojob.com', 'ashbyhq.com', 'oraclecloud.com']
const SUCCESS_TEXT_PATTERNS = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application (has been |was )?submitted/i,
  /application received/i,
  /successfully submitted/i,
  /we('ve| have) received your application/i,
]

function isAtsHost(): boolean {
  return ATS_HOSTS.some(h => window.location.hostname.includes(h))
}

// Remember the last-seen job: confirmation pages no longer show the JD,
// so stash it in sessionStorage (scoped to this tab) while it's visible
function rememberJob(job: JobInfo) {
  try { sessionStorage.setItem('rh-current-job', JSON.stringify(job)) } catch { /* ignore */ }
}

function recallJob(): JobInfo | null {
  try {
    const raw = sessionStorage.getItem('rh-current-job')
    return raw ? JSON.parse(raw) as JobInfo : null
  } catch { return null }
}

function checkSubmitSuccess() {
  if (!isAtsHost()) return
  // record each page once
  const flagKey = `rh-submitted-${window.location.hostname}${window.location.pathname}`
  if (sessionStorage.getItem(flagKey)) return

  const urlHit  = /confirmation|thank[-_]?you|\/success\b/i.test(window.location.href)
  const text    = (document.body?.innerText ?? '').slice(0, 8000)
  const textHit = SUCCESS_TEXT_PATTERNS.some(re => re.test(text))
  if (!urlHit && !textHit) return

  sessionStorage.setItem(flagKey, '1')

  const job: JobInfo = recallJob() ?? {
    id: btoa(window.location.href).slice(0, 32),
    url: window.location.href,
    company: document.title.split(/[-|]/).pop()?.trim() || window.location.hostname,
    title: document.title.split(/[-|]/)[0]?.trim() || 'Unknown Position',
    location: '',
    descriptionRaw: '',
    detectedAt: new Date().toISOString(),
    source: 'generic',
  }
  console.log('[ResumeHelper] 偵測到投遞成功，自動記錄:', job.company, job.title)
  chrome.runtime.sendMessage({ type: 'APPLICATION_SUBMITTED', job })
}

// Poll every 3s on ATS pages (many confirmation pages are SPA swaps, same URL)
if (isAtsHost()) {
  setInterval(checkSubmitSuccess, 3000)
}

// ── Init ──────────────────────────────────────────────────
function init() {
  // ATS application pages: autofill
  tryAutoFill()
  checkSubmitSuccess()

  const job = detectJob()

  if (job) {
    rememberJob(job)
    injectSidebar(job)
    return
  }

  // Detection failed: on known job pages or ANY whitelisted ATS host,
  // still inject the sidebar (manual mode) — application form pages often
  // have no JD text, but the user still wants autofill + cover letter
  const url = window.location.href
  const isJobPage =
    isAtsHost() ||
    url.includes('linkedin.com/jobs/view') ||
    url.includes('linkedin.com/jobs/collections') ||
    url.includes('indeed.com/viewjob')

  if (isJobPage) {
    const fallbackJob: JobInfo = {
      id: btoa(url).slice(0, 32),
      url,
      company: document.title.split(/[-|]/).pop()?.trim() || 'Unknown',
      title: document.title.split(/[-|]/)[0]?.trim() || 'Job Listing',
      location: '',
      descriptionRaw: document.body.innerText.slice(0, 3000),
      detectedAt: new Date().toISOString(),
      source: 'generic',
    }
    rememberJob(fallbackJob)
    injectSidebar(fallbackJob)
  }
}

// Run after the page settles (some SPAs need the wait)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  // Re-detect on SPA route changes
  let lastUrl = window.location.href
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href
      setTimeout(init, 1500)   // let the SPA finish rendering
    }
  }).observe(document, { subtree: true, childList: true })

  init()
}
