import type { JobInfo } from '../shared/types'

let currentJob: JobInfo | null = null

// ── State switching ──────────────────────────────────────
function showState(name: 'ready' | 'error' | 'idle') {
  document.getElementById('stateReady')!.classList.toggle('hidden', name !== 'ready')
  document.getElementById('stateError')!.classList.toggle('hidden', name !== 'error')
  document.getElementById('stateIdle')!.classList.toggle('hidden',  name !== 'idle')
}

function showJobInfo(job: JobInfo) {
  const info = document.getElementById('jobInfo')!
  document.getElementById('jobTitle')!.textContent    = job.title
  document.getElementById('jobCompany')!.textContent  = `${job.company}${job.location ? ` · ${job.location}` : ''}`
  document.getElementById('sourceBadge')!.textContent = job.source
  info.classList.remove('hidden')
  currentJob = job
}

// ── Messages from the content script ─────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg?.type) return

  switch (msg.type) {
    case 'INIT':
      showJobInfo(msg.job as JobInfo)
      showState('ready')
      break

    case 'COVER_LETTER_CHUNK':
      document.getElementById('coverLetterLoading')!.textContent = `✦ 生成中... ${(msg.accumulated as string).length} 字`
      break

    case 'COVER_LETTER_READY': {
      const cl = document.getElementById('coverLetterEditor') as HTMLTextAreaElement
      cl.value = msg.coverLetter as string
      document.getElementById('coverLetterLoading')!.classList.add('hidden')
      document.getElementById('coverLetterSection')!.classList.remove('hidden')
      break
    }

    case 'COVER_LETTER_ERROR':
      document.getElementById('coverLetterLoading')!.textContent = `⚠ ${msg.error}`
      break
  }
})

// ── Button actions ───────────────────────────────────────

// Close
document.getElementById('closeBtn')!.addEventListener('click', () => {
  window.parent.postMessage({ type: 'SIDEBAR_CLOSE' }, '*')
})

// Minimize / expand
document.getElementById('minimizeBtn')!.addEventListener('click', () => {
  document.getElementById('mainContent')!.classList.add('hidden')
  document.getElementById('collapsedTab')!.classList.remove('hidden')
  window.parent.postMessage({ type: 'SIDEBAR_MINIMIZE' }, '*')
})

document.getElementById('expandBtn')!.addEventListener('click', () => {
  document.getElementById('collapsedTab')!.classList.add('hidden')
  document.getElementById('mainContent')!.classList.remove('hidden')
  window.parent.postMessage({ type: 'SIDEBAR_EXPAND' }, '*')
})

// Autofill the form
document.getElementById('fillFormBtn')!.addEventListener('click', () => {
  window.parent.postMessage({ type: 'FILL_FORM', resume: '' }, '*')
})

// Upload the original resume PDF into the page's file input
document.getElementById('uploadPdfBtn')!.addEventListener('click', () => {
  window.parent.postMessage({ type: 'UPLOAD_ORIGINAL_PDF' }, '*')
  const btn = document.getElementById('uploadPdfBtn')!
  btn.textContent = '✓ 上傳中...'
  setTimeout(() => btn.textContent = '⬆ Upload Resume', 2000)
})

// Generate cover letter
document.getElementById('coverLetterBtn')!.addEventListener('click', () => {
  if (!currentJob) return
  document.getElementById('coverLetterLoading')!.textContent = '✦ 生成求職信中...'
  document.getElementById('coverLetterLoading')!.classList.remove('hidden')
  document.getElementById('coverLetterSection')!.classList.add('hidden')
  window.parent.postMessage({ type: 'GENERATE_COVER_LETTER', job: currentJob }, '*')
})

// Copy cover letter
document.getElementById('copyCoverBtn')!.addEventListener('click', async () => {
  const text = (document.getElementById('coverLetterEditor') as HTMLTextAreaElement).value
  await navigator.clipboard.writeText(text)
  const btn = document.getElementById('copyCoverBtn')!
  btn.textContent = '✓'
  setTimeout(() => btn.textContent = '📋', 1500)
})

// Discard
document.getElementById('discardBtn')!.addEventListener('click', () => {
  window.parent.postMessage({ type: 'SIDEBAR_CLOSE' }, '*')
})

// Start in idle state
showState('idle')
