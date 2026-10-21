// User-triggered Workday autofill.
//
// Workday is excluded from the automatic content script (manifest
// exclude_matches) because touching its sign-in / create-account pages broke
// authentication. Instead, the popup injects workdayAutofill() into the active
// tab with chrome.scripting.executeScript({ func }) only when the user clicks.
//
// IMPORTANT: executeScript serializes `func` with toString(), so
// workdayAutofill must be fully self-contained: no imports, no references to
// other top-level functions or constants in this module. Its argument and
// return value must be JSON-serializable.
//
// Rules (by design, keep them):
//   - never act on sign-in / create-account / password pages
//   - only fill name, email, phone, LinkedIn, GitHub; only EMPTY fields
//   - never click anything (Next, Submit, Autofill with Resume, Add…)
//   - never touch dropdowns, textareas, or legal / sponsorship / demographic
//     questions
//   - resume upload is a separate, explicit action

export type WorkdayFillMode = 'fields' | 'resume'

export interface WorkdayFillInput {
  mode: WorkdayFillMode
  profile: {
    name: string
    email: string
    phone: string
    linkedinUrl: string
    githubUrl: string
  }
  resumePdf: { base64: string; name: string } | null
}

export interface WorkdayFillResult {
  status: 'filled' | 'nothing-to-fill' | 'login-page' | 'not-application' | 'no-resume-input' | 'uploaded'
  filled: string[]
  skipped: string[]
  message: string
}

export function isWorkdayUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.endsWith('.myworkdayjobs.com')
  } catch {
    return false
  }
}

export function workdayAutofill(input: WorkdayFillInput): WorkdayFillResult {
  const filled: string[] = []
  const skipped: string[] = []

  const isUsable = (el: Element | null): el is HTMLInputElement => {
    if (!el || el.tagName !== 'INPUT') return false
    const inp = el as HTMLInputElement
    const type = (inp.getAttribute('type') || 'text').toLowerCase()
    if (!['text', 'email', 'tel', 'url', 'search'].includes(type)) return false
    if (inp.disabled || inp.readOnly) return false
    if (inp.getAttribute('role') === 'combobox') return false
    if (inp.closest('[hidden], [aria-hidden="true"]')) return false
    return window.getComputedStyle(inp).display !== 'none'
  }

  const visibleText = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim()

  // ── 1. Authentication pages: do nothing at all ──
  const passwordInput = Array.from(document.querySelectorAll('input[type="password"]'))
    .some(el => !(el as HTMLInputElement).disabled && !el.closest('[hidden], [aria-hidden="true"]'))
  const authHeading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .some(el => /^(sign in|log in|create account|forgot (your )?password|reset (your )?password|verify (your )?(email|account))\b/i
      .test(visibleText(el)))
  const authPath = /\/(login|signin|createaccount|passwordreset|forgotpassword|activate)\b/i.test(window.location.pathname)

  const banner = (text: string) => {
    document.getElementById('jobflow-workday-banner')?.remove()
    const el = document.createElement('div')
    el.id = 'jobflow-workday-banner'
    el.setAttribute('role', 'status')
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:560px;' +
      'background:#1e293b;color:#f8fafc;padding:10px 16px;border-radius:8px;' +
      'font:13px/1.5 sans-serif;z-index:2147483646;box-shadow:0 4px 12px rgba(0,0,0,.3);' +
      'pointer-events:none;white-space:pre-line'
    el.textContent = `JobFlow：${text}`
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 8000)
  }

  const done = (status: WorkdayFillResult['status'], message: string): WorkdayFillResult => {
    banner(message)
    return { status, filled, skipped, message }
  }

  if (passwordInput || authHeading || authPath) {
    return done('login-page', '這是登入或建立帳號頁面，JobFlow 不會動作。請先自行登入，進入申請表後再按 Autofill。')
  }

  // ── 2. Must look like an application form ──
  const APP_MARKERS = [
    '[data-automation-id^="legalNameSection"]',
    '[data-automation-id="phone-number"]',
    '[data-automation-id^="addressSection"]',
    '[data-automation-id="progressBar"]',
    '[data-automation-id="applyFlowPage"]',
    '[data-automation-id="file-upload-input-ref"]',
    '[data-automation-id*="workExperience"]',
    '[data-automation-id*="education"]',
    '[data-automation-id="linkedinQuestion"]',
    'input[id*="legalName--"]',
    'input[id*="phoneNumber--"]',
    'input[id*="address--"]',
  ]
  const isApplication = APP_MARKERS.some(sel => document.querySelector(sel))
  if (!isApplication) {
    return done('not-application', '目前頁面不是 Workday 申請表。請先登入並進入申請表步驟（例如 My Information）後再試。')
  }

  // ── 3a. Resume upload (explicit, separate action) ──
  if (input.mode === 'resume') {
    if (!input.resumePdf) {
      return done('no-resume-input', '尚未在 JobFlow 儲存履歷 PDF，請先在 popup 上傳。')
    }
    const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .filter(el => !el.disabled)
    if (fileInputs.length !== 1) {
      return done('no-resume-input', fileInputs.length === 0
        ? '這個步驟沒有檔案上傳欄位。'
        : '這個步驟有多個檔案上傳欄位，為避免傳錯位置，請手動上傳履歷。')
    }
    const binary = atob(input.resumePdf.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], input.resumePdf.name, { type: 'application/pdf' }))
    fileInputs[0].files = dt.files
    fileInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    fileInputs[0].dispatchEvent(new Event('change', { bubbles: true }))
    filled.push('履歷 PDF')
    return done('uploaded', `已上傳履歷：${input.resumePdf.name}。請確認 Workday 顯示的檔案正確。`)
  }

  // ── 3b. Basic fields ──
  const findByLabel = (pattern: RegExp): HTMLInputElement | null => {
    for (const label of Array.from(document.querySelectorAll('label'))) {
      const text = visibleText(label).replace(/\*/g, '').replace(/\brequired\b/i, '').trim()
      if (!pattern.test(text)) continue
      const target = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input')
      if (isUsable(target)) return target
    }
    return null
  }

  const find = (selectors: string[], label: RegExp | null): HTMLInputElement | null => {
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        // Workday wraps some inputs: the automation id may sit on a container
        const target = el.tagName === 'INPUT' ? el : el.querySelector('input')
        if (isUsable(target)) return target
      }
    }
    return label ? findByLabel(label) : null
  }

  // Native prototype setter: setting el.value directly would update React's
  // value tracker too, and React would then ignore the input event.
  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    el.focus()
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new FocusEvent('blur'))
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    el.blur()
  }

  const fillOne = (label: string, value: string, el: HTMLInputElement | null) => {
    if (!value || !el) return
    if (el.value.trim() !== '') { skipped.push(`${label}（已有內容，未覆寫）`); return }
    setValue(el, value)
    filled.push(label)
  }

  const p = input.profile
  const parts = (p.name || '').trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const last = parts.length > 1 ? parts.slice(1).join(' ') : ''
  // Workday has a separate country-code dropdown; drop a leading +1
  const phone = (p.phone || '').trim().replace(/^\+1[\s.-]*/, '')

  fillOne('First Name', first, find(
    ['[data-automation-id="legalNameSection_firstName"]', 'input[id*="legalName--firstName"]', 'input[name="legalName--firstName"]'],
    /^(legal )?(first|given) name/i))
  fillOne('Last Name', last, find(
    ['[data-automation-id="legalNameSection_lastName"]', 'input[id*="legalName--lastName"]', 'input[name="legalName--lastName"]'],
    /^(legal )?(last|family) name/i))
  fillOne('Email', p.email, find(
    ['[data-automation-id="email"]', 'input[id*="emailAddress"]'],
    /^email( address)?$/i))
  fillOne('Phone', phone, find(
    ['[data-automation-id="phone-number"]', 'input[id*="phoneNumber--phoneNumber"]', 'input[name="phoneNumber"]'],
    /^phone( number)?$/i))
  fillOne('LinkedIn', p.linkedinUrl, find(
    ['[data-automation-id="linkedinQuestion"]', 'input[id*="linkedin" i]', 'input[name*="linkedin" i]'],
    /linkedin/i))
  fillOne('GitHub', p.githubUrl, find(
    ['input[id*="github" i]', 'input[name*="github" i]'],
    /github/i))

  if (filled.length === 0) {
    return done('nothing-to-fill', skipped.length > 0
      ? `沒有需要填的空欄位。${skipped.join('、')}`
      : '這個步驟沒有 JobFlow 能可靠填寫的欄位（姓名、Email、電話、LinkedIn、GitHub）。')
  }
  return done('filled',
    `已填入：${filled.join('、')}` +
    (skipped.length > 0 ? `\n略過：${skipped.join('、')}` : '') +
    '\n請檢查內容，其他問題請自行填寫，並由你自己提交。')
}
