import { getProfile, getResumePdf } from '../shared/storage'
import type { UserProfile } from '../shared/types'

// ── ATS platform detection ────────────────────────────────
// Workday is deliberately absent: the content script never runs there (see
// manifest exclude_matches). Workday autofill is user-triggered via the popup
// and lives in workday-fill.ts.
export type AtsType = 'greenhouse' | 'lever' | 'jazzhr' | 'oracle' | 'ashby' | null

export function detectAts(): AtsType {
  const host = window.location.hostname
  const path = window.location.pathname
  if (host.includes('greenhouse.io') && (path.includes('/jobs/') || path.includes('/apply'))) return 'greenhouse'
  if (host.includes('lever.co') && path.includes('/apply')) return 'lever'
  if (host.includes('applytojob.com')) return 'jazzhr'
  if (host.includes('oraclecloud.com') && path.includes('/apply')) return 'oracle'
  if (host.includes('ashbyhq.com') && (path.includes('/apply') || path.includes('/application'))) return 'ashby'
  return null
}

// ── Main entry ────────────────────────────────────────────
export async function tryAutoFill() {
  const ats = detectAts()
  if (!ats) return

  const profile = await getProfile()
  if (!profile?.name && !profile?.email) return

  await waitForForm(ats)

  const filled: string[] = []
  if (ats === 'greenhouse') filled.push(...fillGreenhouse(profile))
  if (ats === 'lever')      filled.push(...fillLever(profile))
  if (ats === 'jazzhr')     filled.push(...fillJazzHR(profile))
  if (ats === 'oracle')     filled.push(...fillOracle(profile))
  if (ats === 'ashby')      filled.push(...fillAshby(profile))

  if (filled.length > 0) showBanner(`已自動填入：${filled.join('、')}`)
}

// ── PDF injection: stored base64 resume → File → file input ──
function injectPdf(input: HTMLInputElement, pdf: { base64: string; name: string }) {
  const binary = atob(pdf.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const file = new File([bytes], pdf.name, { type: 'application/pdf' })
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.dispatchEvent(new Event('input',  { bubbles: true }))
}

// Sidebar "upload resume" button: find the page's file input and inject the PDF
export async function tryAutoUploadResume() {
  const pdf = await getResumePdf()
  if (!pdf) return
  const input = await waitForFileInput()
  if (input) {
    injectPdf(input, pdf)
    showBanner(`已自動上傳履歷：${pdf.name}`)
  }
}

// Wait for a file input to appear (prefer accept=pdf, up to 15s)
function waitForFileInput(): Promise<HTMLInputElement | null> {
  const preferred = 'input[type="file"][accept*="pdf"], input[type="file"][accept*=".pdf"], input[type="file"][accept*="application"]'
  const fallback  = 'input[type="file"]'
  const find = () =>
    document.querySelector<HTMLInputElement>(preferred) ?? document.querySelector<HTMLInputElement>(fallback)

  const existing = find()
  if (existing) return Promise.resolve(existing)

  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      const el = find()
      if (el) { observer.disconnect(); resolve(el) }
    })
    observer.observe(document.body, { subtree: true, childList: true })
    setTimeout(() => { observer.disconnect(); resolve(null) }, 15_000)
  })
}

// ── Greenhouse ────────────────────────────────────────────
function fillGreenhouse(p: UserProfile): string[] {
  const filled: string[] = []

  const firstName = document.querySelector<HTMLInputElement>('input[name="first_name"], input[id*="first_name"]')
  const lastName  = document.querySelector<HTMLInputElement>('input[name="last_name"],  input[id*="last_name"]')
  const fullName  = document.querySelector<HTMLInputElement>('input[name="name"], input[id*="full_name"]')

  if (firstName && lastName && p.name) {
    const parts = p.name.trim().split(/\s+/)
    firstName.value = parts[0] ?? ''
    lastName.value  = parts.slice(1).join(' ') || parts[0]
    triggerInput(firstName); triggerInput(lastName)
    filled.push('姓名')
  } else if (fullName && p.name) {
    fullName.value = p.name
    triggerInput(fullName)
    filled.push('姓名')
  }

  if (fillEmailFields(p)) filled.push('Email')

  const phone = document.querySelector<HTMLInputElement>('input[name="phone"], input[type="tel"], input[id*="phone"]')
  if (phone && p.phone) { phone.value = p.phone; triggerInput(phone); filled.push('電話') }

  // Newer Greenhouse boards name this field question_12345, so fall back:
  // aria-label → resolve via the visible label text ("LinkedIn Profile")
  const linkedin = document.querySelector<HTMLInputElement>(
    'input[name*="linkedin" i], input[placeholder*="linkedin" i], input[id*="linkedin" i], input[aria-label*="linkedin" i]'
  ) ?? findInputByLabel('linkedin')
  if (linkedin && p.linkedinUrl) { linkedin.value = p.linkedinUrl; triggerInput(linkedin); filled.push('LinkedIn') }

  const location = document.querySelector<HTMLInputElement>(
    'input[name*="location" i], input[id*="location" i], input[placeholder*="city" i]'
  )
  if (location && p.location) { location.value = p.location; triggerInput(location) }

  filled.push(...fillUrlFields(p))

  return filled
}

// ── Lever ─────────────────────────────────────────────────
function fillLever(p: UserProfile): string[] {
  const filled: string[] = []

  const name = document.querySelector<HTMLInputElement>('input[name="name"], input[id*="name"]:not([id*="company"])')
  if (name && p.name) { name.value = p.name; triggerInput(name); filled.push('姓名') }

  if (fillEmailFields(p)) filled.push('Email')

  const phone = document.querySelector<HTMLInputElement>('input[name="phone"], input[type="tel"]')
  if (phone && p.phone) { phone.value = p.phone; triggerInput(phone); filled.push('電話') }

  const linkedinInputs = document.querySelectorAll<HTMLInputElement>(
    'input[name*="linkedin" i], input[placeholder*="linkedin" i]'
  )
  linkedinInputs.forEach(input => {
    if (p.linkedinUrl) { input.value = p.linkedinUrl; triggerInput(input) }
  })
  if (linkedinInputs.length > 0 && p.linkedinUrl) filled.push('LinkedIn')

  filled.push(...fillUrlFields(p))

  return filled
}

// ── JazzHR ────────────────────────────────────────────────
function fillJazzHR(p: UserProfile): string[] {
  const filled: string[] = []

  const first = document.querySelector<HTMLInputElement>('input[name="first_name"], input[id="first_name"]')
  const last  = document.querySelector<HTMLInputElement>('input[name="last_name"],  input[id="last_name"]')
  const full  = document.querySelector<HTMLInputElement>('input[name="name"], input[id="name"]')

  if (first && last && p.name) {
    const parts = p.name.trim().split(/\s+/)
    first.value = parts[0] ?? ''; triggerInput(first)
    last.value  = parts.slice(1).join(' ') || parts[0]; triggerInput(last)
    filled.push('姓名')
  } else if (full && p.name) {
    full.value = p.name; triggerInput(full); filled.push('姓名')
  }

  if (fillEmailFields(p)) filled.push('Email')

  const phone = document.querySelector<HTMLInputElement>('input[name="phone"], input[type="tel"]')
  if (phone && p.phone) { phone.value = p.phone; triggerInput(phone); filled.push('電話') }

  const linkedin = document.querySelector<HTMLInputElement>('input[name*="linkedin" i], input[placeholder*="linkedin" i]')
  if (linkedin && p.linkedinUrl) { linkedin.value = p.linkedinUrl; triggerInput(linkedin); filled.push('LinkedIn') }

  filled.push(...fillUrlFields(p))

  return filled
}

// ── Oracle Cloud ──────────────────────────────────────────
function fillOracle(p: UserProfile): string[] {
  const filled: string[] = []

  const fill = (selector: string, value: string, label: string) => {
    const el = document.querySelector<HTMLInputElement>(selector)
    if (el && value) { el.value = value; triggerInput(el); filled.push(label) }
  }

  const parts = p.name.trim().split(/\s+/)
  fill('input[id*="firstName" i], input[name*="firstName" i]', parts[0] ?? '', '名')
  fill('input[id*="lastName" i],  input[name*="lastName" i]', parts.slice(1).join(' ') || parts[0], '姓')
  if (fillEmailFields(p)) filled.push('Email')
  fill('input[type="tel"], input[id*="phone" i]', p.phone, '電話')

  filled.push(...fillUrlFields(p))

  return filled
}

// ── Ashby ─────────────────────────────────────────────────
function fillAshby(p: UserProfile): string[] {
  const filled: string[] = []

  const name = document.querySelector<HTMLInputElement>('input[name="name"], input[name="fullName"]')
    ?? findInputByLabel('full name') ?? findInputByLabel('name')
  if (name && p.name) { name.value = p.name; triggerInput(name); filled.push('姓名') }

  if (fillEmailFields(p)) {
    filled.push('Email')
  } else {
    const email = findInputByLabel('email')
    if (email && p.email) { email.value = p.email; triggerInput(email); filled.push('Email') }
  }

  const phone = document.querySelector<HTMLInputElement>('input[type="tel"], input[name="phone"]')
    ?? findInputByLabel('phone')
  if (phone && p.phone) { phone.value = p.phone; triggerInput(phone); filled.push('電話') }

  const linkedin = document.querySelector<HTMLInputElement>('input[name*="linkedin" i], input[placeholder*="linkedin" i]')
    ?? findInputByLabel('linkedin')
  if (linkedin && p.linkedinUrl) { linkedin.value = p.linkedinUrl; triggerInput(linkedin); filled.push('LinkedIn') }

  filled.push(...fillUrlFields(p))

  return filled
}

// Resolve an input via its <label> text (Ashby-style label-wrapped fields)
function findInputByLabel(labelText: string): HTMLInputElement | null {
  for (const label of Array.from(document.querySelectorAll('label'))) {
    if (!label.textContent?.toLowerCase().includes(labelText.toLowerCase())) continue

    if (label.htmlFor) {
      const el = document.getElementById(label.htmlFor)
      if (el?.tagName === 'INPUT') return el as HTMLInputElement
    }
    const inside = label.querySelector('input')
    if (inside) return inside

    const next = label.nextElementSibling
    if (next?.tagName === 'INPUT') return next as HTMLInputElement
    const nextInside = next?.querySelector('input')
    if (nextInside) return nextInside

    const parent = label.parentElement
    if (parent) {
      const el = parent.querySelector<HTMLInputElement>(
        'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])'
      )
      if (el) return el
    }
  }
  return null
}

// ── Utilities ─────────────────────────────────────────────

// Fill GitHub and "Other website / Portfolio / Personal website" fields
// (every ATS names them differently; the GitHub URL covers them all)
function fillUrlFields(p: UserProfile): string[] {
  const filled: string[] = []
  if (!p.githubUrl) return filled

  const fillAll = (selector: string): boolean => {
    let hit = false
    document.querySelectorAll<HTMLInputElement>(selector).forEach(el => {
      if (el.type === 'hidden' || el.disabled || el.readOnly || el.value) return
      el.value = p.githubUrl
      triggerInput(el)
      hit = true
    })
    return hit
  }

  if (fillAll(
    'input[name*="github" i], input[id*="github" i], input[placeholder*="github" i], input[aria-label*="github" i]'
  )) filled.push('GitHub')

  if (fillAll(
    'input[name*="website" i], input[id*="website" i], input[placeholder*="website" i], ' +
    'input[name*="portfolio" i], input[id*="portfolio" i], input[placeholder*="portfolio" i], ' +
    'input[aria-label*="website" i], input[aria-label*="portfolio" i]'
  )) filled.push('網站')

  return filled
}

// Fill email: match name / type / id / placeholder / aria-label variants,
// and fill every email field on the page (including "confirm email")
function fillEmailFields(p: UserProfile): boolean {
  if (!p.email) return false
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input[name="email"], input[type="email"], input[id*="email" i], ' +
    'input[autocomplete="email"], input[placeholder*="email" i], input[aria-label*="email" i]'
  )
  let filled = false
  inputs.forEach(el => {
    if (el.type === 'hidden' || el.disabled || el.readOnly) return
    el.value = p.email
    triggerInput(el)
    filled = true
  })
  if (!filled) console.log('[ResumeHelper] 找不到 Email 欄位，請回報這個頁面網址')
  return filled
}

// Dispatch input + change events so React/Vue notice the value change
function triggerInput(el: HTMLInputElement | HTMLTextAreaElement) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  nativeInputValueSetter?.call(el, el.value)
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// Wait for the form to appear (up to 12s)
function waitForForm(ats: AtsType): Promise<void> {
  const selectors: Record<NonNullable<AtsType>, string> = {
    greenhouse: 'input[name="email"], input[type="email"]',
    lever:      'input[name="email"], input[type="email"]',
    jazzhr:     'input[name="email"], input[type="email"]',
    oracle:     'input[type="email"], input[id*="email" i]',
    ashby:      'input[type="email"], input[name*="email" i]',
  }
  const selector = selectors[ats!]
  return new Promise(resolve => {
    if (document.querySelector(selector)) { resolve(); return }
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { observer.disconnect(); resolve() }
    })
    observer.observe(document.body, { subtree: true, childList: true })
    setTimeout(() => { observer.disconnect(); resolve() }, 12_000)
  })
}

// Floating toast
function showBanner(message: string) {
  const existing = document.getElementById('rh-fill-banner')
  if (existing) existing.remove()

  const banner = document.createElement('div')
  banner.id = 'rh-fill-banner'
  banner.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #1e293b; color: #f8fafc; padding: 10px 18px;
    border-radius: 8px; font-size: 13px; font-family: sans-serif;
    z-index: 2147483646; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    display: flex; align-items: center; gap: 8px;
    animation: rh-slide-up 0.3s ease;
  `
  banner.innerHTML = `
    <style>@keyframes rh-slide-up { from { opacity:0; transform:translateX(-50%) translateY(10px) } to { opacity:1; transform:translateX(-50%) translateY(0) } }</style>
    <span style="color:#6ee7b7">✓</span> Resume Helper：${message}
    <button onclick="this.parentElement.remove()" style="margin-left:8px;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px">✕</button>
  `
  document.body.appendChild(banner)
  setTimeout(() => banner.remove(), 6000)
}
