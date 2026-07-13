import * as pdfjsLib from 'pdfjs-dist'
import { getProfile, saveProfile, getApplications, saveResumePdf } from '../shared/storage'
import type { UserProfile } from '../shared/types'

// pdf.js worker from a local file (Chrome extension CSP)
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js')

// ── Tab switching ─────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = (tab as HTMLElement).dataset.tab!
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
    tab.classList.add('active')
    document.getElementById(`tab-${target}`)!.classList.add('active')
    if (target === 'history') { loadHistory(); loadSheetSummary() }
  })
})

// ── Shared: extract text from a PDF (line breaks inferred from font height) ──
async function extractTextFromPdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let fullText = ''

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()

    // Collect valid items with x / y / font height
    const items = (content.items as any[])
      .filter(item => item.str?.trim() && item.transform)
      .map(item => ({
        x:      item.transform[4],
        y:      item.transform[5],
        height: item.height > 0 ? item.height : 8,  // fallback 8px
        str:    item.str as string,
      }))
      .sort((a, b) => b.y - a.y || a.x - b.x)  // top of page first, then left to right

    // Group items into lines: Y gap > 40% of the line's avg font height → new line
    const lines: Array<Array<typeof items[0]>> = []
    let currentLine: typeof items = []

    for (const item of items) {
      if (currentLine.length === 0) {
        currentLine.push(item)
        continue
      }
      const avgHeight = currentLine.reduce((s, i) => s + i.height, 0) / currentLine.length
      const prevY    = currentLine[currentLine.length - 1].y
      const gap      = prevY - item.y

      if (gap > avgHeight * 0.4) {
        lines.push(currentLine)
        currentLine = [item]
      } else {
        currentLine.push(item)
      }
    }
    if (currentLine.length > 0) lines.push(currentLine)

    const pageText = lines
      .map(line =>
        line
          .sort((a, b) => a.x - b.x)
          .map(i => i.str)
          .join(' ')
          .trim()
      )
      .filter(l => l.length > 0)
      .join('\n')

    fullText += pageText + '\n'
  }

  return fullText.trim()
}

// ── Resume PDF upload ─────────────────────────────────────
const uploadArea = document.getElementById('uploadArea')!
const resumeFileInput = document.getElementById('resumeFile') as HTMLInputElement
const uploadStatus = document.getElementById('uploadStatus')!
const baseResumeTextArea = document.getElementById('baseResumeText') as HTMLTextAreaElement

uploadArea.addEventListener('dragenter', e => { e.preventDefault(); uploadArea.classList.add('dragover') })
uploadArea.addEventListener('dragover',  e => { e.preventDefault(); uploadArea.classList.add('dragover') })
uploadArea.addEventListener('dragleave', e => {
  if (!uploadArea.contains(e.relatedTarget as Node)) uploadArea.classList.remove('dragover')
})
uploadArea.addEventListener('drop', e => {
  e.preventDefault()
  uploadArea.classList.remove('dragover')
  const dt = e.dataTransfer
  console.log('[ResumeHelper] drop files:', dt?.files?.length, 'items:', dt?.items?.length)
  const file = dt?.files?.[0]
    ?? (dt?.items?.[0]?.kind === 'file' ? (dt.items[0].getAsFile() ?? undefined) : undefined)
  if (file) {
    handleResumePdf(file)
  } else {
    showStatus(uploadStatus, '未能取得檔案，請改用點擊上傳', 'error')
  }
})
resumeFileInput.addEventListener('change', () => {
  const file = resumeFileInput.files?.[0]
  if (file) handleResumePdf(file)
})

async function handleResumePdf(file: File) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showStatus(uploadStatus, '請上傳 PDF 格式的檔案', 'error')
    return
  }
  showStatus(uploadStatus, '解析中...', 'loading')
  uploadArea.classList.remove('success')

  try {
    const text = await extractTextFromPdf(file)
    if (text.trim().length < 50) {
      showStatus(uploadStatus, '無法擷取文字，請改為手動貼上履歷內容', 'error')
      return
    }
    baseResumeTextArea.value = text
    uploadArea.classList.add('success')
    uploadArea.querySelector('.upload-text')!.textContent = `✓ ${file.name}`
    uploadArea.querySelector('.upload-hint')!.textContent = `${text.length} 個字元已擷取`
    showStatus(uploadStatus, `✓ 成功擷取 ${text.length} 個字元`, 'success')

    // Save PDF as base64 (content script uses it for auto-upload)
    const arrayBuffer = await file.arrayBuffer()
    const uint8 = new Uint8Array(arrayBuffer)
    let binary = ''
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i])
    await saveResumePdf(btoa(binary), file.name)

    // Auto-fill basics from the resume text
    autoFillProfileFromResume(text)
  } catch (err) {
    showStatus(uploadStatus, 'PDF 解析失敗，請改為手動貼上', 'error')
    console.error(err)
  }
}

// Extract name, email, phone, LinkedIn and location from resume text
function autoFillProfileFromResume(text: string) {
  const nameEl     = document.getElementById('name')        as HTMLInputElement
  const emailEl    = document.getElementById('email')       as HTMLInputElement
  const phoneEl    = document.getElementById('phone')       as HTMLInputElement
  const linkedinEl = document.getElementById('linkedinUrl') as HTMLInputElement
  const locationEl = document.getElementById('location')    as HTMLInputElement

  // ── Email ──────────────────────────────────────────────
  const emailMatch = text.match(/[\w.+\-]+@[\w\-]+\.[\w.]+/)
  if (emailMatch) emailEl.value = emailMatch[0]

  // ── Phone: US + Taiwan formats ─────────────────────────
  const phonePatterns = [
    /(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/,     // (415) 555-1234 / 415-555-1234
    /(\+1[-.\s]?)?\d{10}/,                                   // 4155551234
    /(\+886[-\s]?|0)(9\d{2}|[2-8]\d)[-\s]?\d{3,4}[-\s]?\d{4}/, // Taiwan
  ]
  for (const pattern of phonePatterns) {
    const m = text.match(pattern)
    if (m) { phoneEl.value = m[0].trim(); break }
  }

  // ── LinkedIn: with or without https:// ─────────────────
  const linkedinMatch = text.match(/(https?:\/\/)?(www\.)?linkedin\.com\/in\/[\w\-]+\/?/)
  if (linkedinMatch) {
    const raw = linkedinMatch[0]
    linkedinEl.value = raw.startsWith('http') ? raw : `https://${raw}`
  }

  // ── Location: match real US state codes only ────────────
  // States listed explicitly so name initials never match
  const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC'
  // [ ] instead of \s so the match never crosses newlines (keeps surnames out of city names)
  const locationRegex = new RegExp(
    `((?:[A-Z][a-z]+)(?:[ ][A-Z][a-z]+){0,3}),[ ]*(${US_STATES})\\b(?:[ ]+\\d{5})?`
  )
  const locationMatch = text.match(locationRegex)
  if (locationMatch) {
    locationEl.value = `${locationMatch[1].trim()}, ${locationMatch[2]}`
  } else {
    // Fallback: explicit "Location: ..." label (single line only)
    const labelMatch = text.match(/(?:Location|City)[:\s]+([A-Za-z][A-Za-z ,]{2,35})(?:\n|$)/i)
    if (labelMatch) locationEl.value = labelMatch[1].trim()
  }

  // ── Name ───────────────────────────────────────────────
  // 1. Explicit "Name: ..." label (supports hyphenated names like Ching-Yen Lee)
  const namedMatch = text.match(/(?:^|\n)\s*(?:Name|Full Name)[:\s]+([A-Za-z][A-Za-z\-\s\u4e00-\u9fa5]{1,30})/)
  if (namedMatch) {
    nameEl.value = namedMatch[1].trim()
  } else {
    // 2. Otherwise pick the most name-like line near the top
    //    letters/hyphens/spaces only; 1–3 words; no punctuation
    const skipWords = /^(resume|curriculum|vitae|education|experience|skills|contact|summary|objective|profile|university|college)/i
    const nameLine = text.split('\n')
      .slice(0, 8)
      .map(l => l.trim())
      .find(l =>
        // reasonable length
        l.length >= 2 && l.length <= 40 &&
        // letters, spaces and hyphens only
        /^[A-Za-z\u4e00-\u9fa5][A-Za-z\u4e00-\u9fa5\s\-]{1,38}$/.test(l) &&
        // no contact info
        !l.includes('@') && !l.match(/\d/) &&
        !l.match(/https?:\/\//) && !l.match(/linkedin/i) &&
        // not a known section heading
        !skipWords.test(l) &&
        // not the detected location
        l !== locationEl.value
      )
    if (nameLine) nameEl.value = nameLine
  }

  // ── Show what was filled ───────────────────────────────
  const filled: string[] = []
  if (nameEl.value)     filled.push('姓名')
  if (emailEl.value)    filled.push('Email')
  if (phoneEl.value)    filled.push('電話')
  if (linkedinEl.value) filled.push('LinkedIn')
  if (locationEl.value) filled.push('所在地')

  showStatus(
    uploadStatus,
    filled.length > 0
      ? `✓ 已自動填入：${filled.join('、')}`
      : '✓ 文字擷取成功，請手動填入基本資料',
    'success'
  )
}

// ── Transcript PDF upload ─────────────────────────────────
const transcriptUploadArea = document.getElementById('transcriptUploadArea')!
const transcriptFileInput = document.getElementById('transcriptFile') as HTMLInputElement
const transcriptUploadStatus = document.getElementById('transcriptUploadStatus')!

transcriptUploadArea.addEventListener('dragenter', e => { e.preventDefault(); transcriptUploadArea.classList.add('dragover') })
transcriptUploadArea.addEventListener('dragover',  e => { e.preventDefault(); transcriptUploadArea.classList.add('dragover') })
transcriptUploadArea.addEventListener('dragleave', e => {
  if (!transcriptUploadArea.contains(e.relatedTarget as Node)) transcriptUploadArea.classList.remove('dragover')
})
transcriptUploadArea.addEventListener('drop', e => {
  e.preventDefault()
  transcriptUploadArea.classList.remove('dragover')
  const dt = e.dataTransfer
  console.log('[ResumeHelper] transcript drop files:', dt?.files?.length, 'items:', dt?.items?.length)
  const file = dt?.files?.[0]
    ?? (dt?.items?.[0]?.kind === 'file' ? (dt.items[0].getAsFile() ?? undefined) : undefined)
  if (file) {
    handleTranscriptPdf(file)
  } else {
    showStatus(transcriptUploadStatus, '未能取得檔案，請改用點擊上傳', 'error')
  }
})
transcriptFileInput.addEventListener('change', () => {
  const file = transcriptFileInput.files?.[0]
  if (file) handleTranscriptPdf(file)
})

async function handleTranscriptPdf(file: File) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showStatus(transcriptUploadStatus, '請上傳 PDF 格式的檔案', 'error')
    return
  }
  showStatus(transcriptUploadStatus, '解析成績單中...', 'loading')

  try {
    const text = await extractTextFromPdf(file)
    if (text.trim().length < 20) {
      showStatus(transcriptUploadStatus, '無法擷取成績單文字', 'error')
      return
    }

    // Keep the raw transcript text (for Claude later)
    ;(document.getElementById('transcriptText') as HTMLInputElement | null)
    // Stash in a data attribute
    transcriptUploadArea.dataset.text = text

    const { gpa, semester } = extractGpaFromTranscript(text)
    const gpaEl      = document.getElementById('transcriptGpa')      as HTMLInputElement
    const semesterEl = document.getElementById('transcriptSemester') as HTMLInputElement

    if (gpa) gpaEl.value = gpa
    if (semester) semesterEl.value = semester

    transcriptUploadArea.classList.add('success')
    transcriptUploadArea.querySelector('.upload-text')!.textContent = `✓ ${file.name}`
    transcriptUploadArea.querySelector('.upload-hint')!.textContent = gpa
      ? `GPA: ${gpa}` : '請手動填入 GPA'

    showStatus(transcriptUploadStatus,
      gpa ? `✓ 擷取到 GPA：${gpa}${semester ? `（${semester}）` : ''}` : '已上傳，請手動填入 GPA',
      gpa ? 'success' : 'loading'
    )
  } catch (err) {
    showStatus(transcriptUploadStatus, '成績單解析失敗', 'error')
    console.error(err)
  }
}

// Extract the latest-semester GPA from transcript text (US semester system)
function extractGpaFromTranscript(text: string): { gpa: string; semester: string } {
  let gpa = ''
  let semester = ''

  // ── GPA ─────────────────────────────────────────────────
  const gpaPatterns = [
    /(?:Term|Semester|Cumulative|Overall|Session)\s+GPA[\s:]*(\d\.\d{2,3})/i,  // Term GPA 3.85
    /GPA[\s:]*(\d\.\d{2,3})\s*\/?\s*(4\.0|4\.00)?/i,                           // GPA: 3.85 / 4.0
    /(?:Grade\s+Point\s+Average)[\s:]*(\d\.\d{2,3})/i,                          // Grade Point Average 3.85
    /(?:Average|Avg)[\s.:]*(\d\.\d{2,3})/i,                                     // Average: 3.85
  ]

  for (const pattern of gpaPatterns) {
    const m = text.match(pattern)
    if (m) {
      gpa = m[2] ? `${m[1]} / ${m[2]}` : `${m[1]} / 4.0`
      break
    }
  }

  // ── Semester: take the last occurrence (most recent) ────
  // Formats: Fall 2024, Spring 2025, Summer 2024,
  //          2024 Fall、Fall Semester 2024、Spring Term 2025
  const semesterPattern = /\b(Fall|Spring|Summer|Winter)(?:\s+(?:Semester|Term|Quarter))?\s+(20\d{2})\b|(20\d{2})\s+(Fall|Spring|Summer|Winter)\b/gi
  const matches = [...text.matchAll(semesterPattern)]

  if (matches.length > 0) {
    // Last one wins (transcripts are chronological)
    const last = matches[matches.length - 1]
    // group 1+2 = "Fall 2024"，group 3+4 = "2024 Fall"
    semester = last[1]
      ? `${last[1]} ${last[2]}`   // Fall 2024
      : `${last[4]} ${last[3]}`   // 2024 Fall → Fall 2024
  }

  return { gpa, semester }
}

// ── Shared: status messages ───────────────────────────────
function showStatus(el: HTMLElement, message: string, type: 'loading' | 'success' | 'error') {
  el.textContent = message
  el.className = `upload-status ${type}`
  el.classList.remove('hidden')
}

// ── Profile: load ─────────────────────────────────────────
async function loadProfile() {
  const profile = await getProfile()
  if (!profile) return

  ;(document.getElementById('name')         as HTMLInputElement).value = profile.name
  ;(document.getElementById('email')        as HTMLInputElement).value = profile.email
  ;(document.getElementById('phone')        as HTMLInputElement).value = profile.phone
  ;(document.getElementById('location')     as HTMLInputElement).value = profile.location
  ;(document.getElementById('linkedinUrl')  as HTMLInputElement).value = profile.linkedinUrl
  ;(document.getElementById('githubUrl')    as HTMLInputElement).value = profile.githubUrl ?? ''
  ;(document.getElementById('workerUrl')    as HTMLInputElement).value = profile.workerUrl ?? ''
  ;(document.getElementById('workerToken')  as HTMLInputElement).value = profile.workerToken ?? ''
  ;(document.getElementById('sheetsId')     as HTMLInputElement).value = profile.sheetsId
  baseResumeTextArea.value = profile.baseResumeText

  if (profile.baseResumeText) {
    uploadArea.querySelector('.upload-text')!.textContent = '✓ 已有履歷文字'
    uploadArea.querySelector('.upload-hint')!.textContent = `${profile.baseResumeText.length} 個字元`
    uploadArea.classList.add('success')
  }

  // Load transcript data
  if (profile.transcriptGpa) {
    ;(document.getElementById('transcriptGpa')      as HTMLInputElement).value = profile.transcriptGpa
    ;(document.getElementById('transcriptSemester') as HTMLInputElement).value = profile.transcriptSemester
    transcriptUploadArea.classList.add('success')
    transcriptUploadArea.querySelector('.upload-text')!.textContent = '✓ 已有成績單資料'
    transcriptUploadArea.querySelector('.upload-hint')!.textContent = `GPA: ${profile.transcriptGpa}`
    if (profile.transcriptText) transcriptUploadArea.dataset.text = profile.transcriptText
  }
}

// ── Profile: save ─────────────────────────────────────────
document.getElementById('saveProfile')!.addEventListener('click', async () => {
  const btn      = document.getElementById('saveProfile') as HTMLButtonElement
  const statusEl = document.getElementById('saveStatus')!

  const profile: UserProfile = {
    name:               (document.getElementById('name')         as HTMLInputElement).value.trim(),
    email:              (document.getElementById('email')        as HTMLInputElement).value.trim(),
    phone:              (document.getElementById('phone')        as HTMLInputElement).value.trim(),
    location:           (document.getElementById('location')     as HTMLInputElement).value.trim(),
    linkedinUrl:        (document.getElementById('linkedinUrl')  as HTMLInputElement).value.trim(),
    githubUrl:          (document.getElementById('githubUrl')    as HTMLInputElement).value.trim(),
    baseResumeText:     baseResumeTextArea.value.trim(),
    workerUrl:          (document.getElementById('workerUrl')    as HTMLInputElement).value.trim(),
    workerToken:        (document.getElementById('workerToken')  as HTMLInputElement).value.trim(),
    sheetsId:           (document.getElementById('sheetsId')     as HTMLInputElement).value.trim(),
    transcriptGpa:      (document.getElementById('transcriptGpa')      as HTMLInputElement).value.trim(),
    transcriptSemester: (document.getElementById('transcriptSemester') as HTMLInputElement).value.trim(),
    transcriptText:     transcriptUploadArea.dataset.text ?? '',
  }

  if (!profile.name || !profile.email) {
    showStatus(statusEl, '請填寫姓名和 Email', 'error')
    return
  }
  if (!profile.baseResumeText) {
    showStatus(statusEl, '請上傳履歷或貼上履歷文字', 'error')
    return
  }

  btn.disabled = true
  btn.textContent = '儲存中...'
  try {
    await saveProfile(profile)

    showStatus(statusEl, '✓ 設定已儲存', 'success')
    setTimeout(() => statusEl.classList.add('hidden'), 3000)
  } catch {
    showStatus(statusEl, '儲存失敗，請再試一次', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = '儲存設定'
  }
})

// Note: alert settings, manual scan and the local queue were removed 2026-07-12 —
// crawling and notifications live in the Cloudflare Worker; the popup only reads ledgers.

// ── Google Sheet stats + latest jobs ──────────────────────
// Calls Apps Script doGet(?action=summary) for totals, open count,
// application stats, and the latest 15 un-applied jobs
async function loadSheetSummary() {
  const container = document.getElementById('sheetJobsList')!
  const statsEl   = document.getElementById('funnelStats')!

  const profile = await getProfile()
  if (!profile?.sheetsId || !profile.sheetsId.startsWith('http')) {
    container.innerHTML = '<div class="empty-state">請先在「個人資料」填入 Apps Script Webhook 網址</div>'
    return
  }

  try {
    const res = await fetch(`${profile.sheetsId}${profile.sheetsId.includes('?') ? '&' : '?'}action=summary`)
    const data = await res.json()
    if (!data.ok) throw new Error('bad response')

    // Stats row
    const s = data.stats
    const statusParts = Object.entries(s.byStatus as Record<string, number>)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')
    statsEl.innerHTML = `
      <div class="funnel-item"><span class="funnel-num">${s.jobsOpen}</span><span class="funnel-label">開放中</span></div>
      <div class="funnel-item"><span class="funnel-num">${s.jobsTotal}</span><span class="funnel-label">職缺總數</span></div>
      <div class="funnel-item"><span class="funnel-num">${s.applied}</span><span class="funnel-label">已投遞</span></div>
      ${statusParts ? `<div class="funnel-status">${escapeHtml(statusParts)}</div>` : ''}
    `
    statsEl.classList.remove('hidden')

    // Latest jobs list
    const jobs = data.jobs as Array<{ date: string; company: string; title: string; location: string; salary: string; source: string; url: string }>
    if (jobs.length === 0) {
      container.innerHTML = '<div class="empty-state">Sheet 裡還沒有職缺，等爬蟲跑一輪吧</div>'
      return
    }
    container.innerHTML = jobs.map(j => `
      <div class="history-item sheet-job" data-url="${escapeHtml(j.url)}">
        <div class="history-company">${escapeHtml(j.company)}${j.salary ? ` <span class="job-salary">${escapeHtml(j.salary)}</span>` : ''}</div>
        <div class="history-title">${escapeHtml(j.title)}</div>
        <div class="history-meta">
          <span>${escapeHtml(j.location || '')}</span>
          <span>${escapeHtml(j.date)}</span>
        </div>
      </div>
    `).join('')

    container.querySelectorAll<HTMLElement>('.sheet-job').forEach(el => {
      el.addEventListener('click', () => {
        const url = el.dataset.url
        if (url) chrome.tabs.create({ url })
      })
    })
  } catch {
    container.innerHTML = '<div class="empty-state">讀取失敗——確認 Apps Script 已部署、網址填的是 /exec 結尾</div>'
  }
}

// ── Application history ───────────────────────────────────
async function loadHistory() {
  const apps = await getApplications()
  const container = document.getElementById('historyList')!
  if (apps.length === 0) {
    container.innerHTML = '<div class="empty-state">還沒有投遞紀錄</div>'
    return
  }
  container.innerHTML = apps.slice(0, 20).map(app => `
    <div class="history-item">
      <div class="history-company">${escapeHtml(app.job.company)}</div>
      <div class="history-title">${escapeHtml(app.job.title)}</div>
      <div class="history-meta">
        <span>${new Date(app.appliedAt).toLocaleDateString('zh-TW')}</span>
        <span class="status-badge status-${app.status}">${statusLabel(app.status)}</span>
      </div>
    </div>
  `).join('')
}

function statusLabel(status: string): string {
  return ({ draft: '草稿', filled: '已填表', submitted: '已投遞' } as Record<string, string>)[status] ?? status
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Init ──────────────────────────────────────────────────
loadProfile()
