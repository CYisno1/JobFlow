// Workday autofill regression tests (happy-dom, no browser, no credentials).
// Run: npm test

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { isWorkdayUrl, workdayAutofill, type WorkdayFillInput, type WorkdayFillResult } from '../src/content/workday-fill.ts'

// chrome.scripting.executeScript serializes the function with toString(), so
// every test runs the re-parsed copy: this fails if the function ever starts
// depending on module-scope code.
const injected = new Function(`return (${workdayAutofill.toString()})`)() as typeof workdayAutofill

const PROFILE: WorkdayFillInput['profile'] = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 555-010-0199',
  linkedinUrl: 'https://linkedin.com/in/ada',
  githubUrl: 'https://github.com/ada',
}
const PDF = { base64: Buffer.from('%PDF-1.4 test').toString('base64'), name: 'Ada_Resume.pdf' }

function page(html: string, path = '/en-US/careers/job/apply/applyManually') {
  const window = new Window({ url: `https://acme.wd5.myworkdayjobs.com${path}` })
  window.document.body.innerHTML = html
  const g = globalThis as any
  g.window = window
  g.document = window.document
  for (const name of ['Event', 'FocusEvent', 'DataTransfer', 'File', 'HTMLInputElement']) g[name] = (window as any)[name]
  return window
}

function run(mode: WorkdayFillInput['mode'] = 'fields', resumePdf: WorkdayFillInput['resumePdf'] = null): WorkdayFillResult {
  return injected({ mode, profile: PROFILE, resumePdf })
}

const $ = (sel: string) => document.querySelector(sel) as HTMLInputElement

// Minimal model of React's controlled-input value tracking: React records the
// value on assignment through the instance property and only fires onChange
// when an input event reveals a DOM value different from the tracked one.
function reactControlled(el: HTMLInputElement): () => string {
  const desc = Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')!
  let tracked = desc.get!.call(el)
  let state = tracked
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get!.call(this) },
    set(v) { tracked = String(v); desc.set!.call(this, v) },
  })
  el.addEventListener('input', () => {
    const current = desc.get!.call(el)
    if (current !== tracked) { tracked = current; state = current }
  })
  return () => state
}

const MY_INFORMATION = `
  <div data-automation-id="progressBar"></div>
  <div data-automation-id="legalNameSection_firstName"><label for="fn">First Name*</label><input id="fn" type="text"></div>
  <div data-automation-id="legalNameSection_lastName"><label for="ln">Last Name*</label><input id="ln" type="text"></div>
  <input data-automation-id="email" id="em" type="text">
  <button data-automation-id="countryPhoneCode" aria-haspopup="listbox">+1</button>
  <input data-automation-id="phone-number" id="ph" type="text">
  <label for="li">LinkedIn</label><input id="li" type="text">
  <label for="sp">Will you now or in the future require sponsorship?</label><input id="sp" type="text">
  <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
  <select id="gender"><option value="">Select</option><option>Female</option></select>
  <button data-automation-id="bottom-navigation-next-button">Save and Continue</button>
  <button data-automation-id="pageFooterSubmitButton">Submit</button>
`

// ── URL gate ────────────────────────────────────────────────

test('isWorkdayUrl only accepts https *.myworkdayjobs.com', () => {
  assert.equal(isWorkdayUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x'), true)
  assert.equal(isWorkdayUrl('http://acme.wd5.myworkdayjobs.com/'), false)
  assert.equal(isWorkdayUrl('https://myworkdayjobs.com.evil.example/'), false)
  assert.equal(isWorkdayUrl('https://boards.greenhouse.io/acme'), false)
  assert.equal(isWorkdayUrl(undefined), false)
  assert.equal(isWorkdayUrl('not a url'), false)
})

// ── Authentication pages are never touched ──────────────────

test('sign-in page: does nothing', () => {
  page(`
    <h2>Sign In</h2>
    <input data-automation-id="email" id="em" type="text">
    <input data-automation-id="password" type="password">
    <button data-automation-id="signInSubmitButton">Sign In</button>`, '/en-US/careers/login')
  const r = run()
  assert.equal(r.status, 'login-page')
  assert.deepEqual(r.filled, [])
  assert.equal($('#em').value, '')
})

test('create-account page: does nothing even with an application-like marker', () => {
  page(`
    <div data-automation-id="progressBar"></div>
    <h2>Create Account</h2>
    <input data-automation-id="email" id="em" type="text">
    <input data-automation-id="password" type="password">
    <input data-automation-id="verifyPassword" type="password">`)
  const r = run()
  assert.equal(r.status, 'login-page')
  assert.equal($('#em').value, '')
})

test('forgot-password page (no password field): does nothing', () => {
  page(`
    <h2>Forgot your password?</h2>
    <input data-automation-id="email" id="em" type="text">`)
  assert.equal(run().status, 'login-page')
  assert.equal($('#em').value, '')
})

test('a typed email on the sign-in page is never overwritten', () => {
  page(`<input data-automation-id="email" id="em" type="text"><input type="password">`)
  $('#em').value = 'my-other@example.com'
  run()
  assert.equal($('#em').value, 'my-other@example.com')
})

test('resume mode also refuses on sign-in pages', () => {
  page(`<input type="file"><input type="password">`)
  const r = run('resume', PDF)
  assert.equal(r.status, 'login-page')
  assert.equal(($('input[type=file]') as HTMLInputElement).files?.length ?? 0, 0)
})

// ── Non-application pages ───────────────────────────────────

test('job description page: reports not-application and fills nothing', () => {
  page(`<h1>Software Engineer I</h1><div data-automation-id="jobPostingDescription">About the role</div>
        <a data-automation-id="adventureButton">Apply</a><input id="search" type="text">`, '/en-US/careers/job/NY/Software-Engineer-I_R123')
  const r = run()
  assert.equal(r.status, 'not-application')
  assert.equal($('#search').value, '')
})

// ── Application form ────────────────────────────────────────

test('My Information: fills only reliable fields, React sees the change', () => {
  page(MY_INFORMATION)
  const firstState = reactControlled($('#fn'))
  const emailState = reactControlled($('#em'))
  let clicks = 0
  document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => clicks++))

  const r = run()
  assert.equal(r.status, 'filled')
  assert.deepEqual(r.filled, ['First Name', 'Last Name', 'Email', 'Phone', 'LinkedIn'])
  assert.equal($('#fn').value, 'Ada')
  assert.equal($('#ln').value, 'Lovelace')
  assert.equal($('#em').value, 'ada@example.com')
  assert.equal($('#ph').value, '555-010-0199', 'leading +1 dropped (Workday has a country-code dropdown)')
  assert.equal($('#li').value, 'https://linkedin.com/in/ada')
  assert.equal(firstState(), 'Ada', 'React state updated')
  assert.equal(emailState(), 'ada@example.com', 'React state updated')

  // Never touched: sponsorship text question, free text, dropdown, buttons
  assert.equal($('#sp').value, '')
  assert.equal((document.querySelector('#why') as HTMLTextAreaElement).value, '')
  assert.equal((document.querySelector('#gender') as HTMLSelectElement).value, '')
  assert.equal(clicks, 0, 'no button was clicked')
})

test('regression: the old el.value + native setter approach does NOT update React state', () => {
  page(MY_INFORMATION)
  const el = $('#fn')
  const state = reactControlled(el)
  // Old triggerInput(): assign through the instance first, then the native setter
  el.value = 'Ada'
  Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')!.set!.call(el, el.value)
  el.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }))
  assert.equal(state(), '', 'React never saw the value — this was the Workday bug')
})

test('newer Workday ids (name--legalName--firstName etc.) are supported', () => {
  page(`
    <div data-automation-id="formField-legalName--firstName"><input id="name--legalName--firstName" type="text"></div>
    <div data-automation-id="formField-legalName--lastName"><input id="name--legalName--lastName" type="text"></div>
    <input id="phoneNumber--phoneNumber" type="text">`)
  const r = run()
  assert.deepEqual(r.filled, ['First Name', 'Last Name', 'Phone'])
  assert.equal($('#name--legalName--firstName').value, 'Ada')
})

test('never overwrites values the user already entered', () => {
  page(MY_INFORMATION)
  $('#em').value = 'typed@example.com'
  $('#fn').value = 'A.'
  const r = run()
  assert.equal($('#em').value, 'typed@example.com')
  assert.equal($('#fn').value, 'A.')
  assert.ok(r.skipped.some(s => s.startsWith('Email')))
  assert.ok(r.skipped.some(s => s.startsWith('First Name')))
})

test('running twice is harmless (second run has nothing to fill)', () => {
  page(MY_INFORMATION)
  run()
  const r = run()
  assert.equal(r.status, 'nothing-to-fill')
  assert.deepEqual(r.filled, [])
})

test('skips disabled, read-only and hidden inputs', () => {
  page(`
    <div data-automation-id="progressBar"></div>
    <input data-automation-id="email" id="em" type="text" readonly>
    <input data-automation-id="phone-number" id="ph" type="text" disabled>
    <div hidden><input id="githubX" name="github" type="text"></div>`)
  const r = run()
  assert.equal(r.status, 'nothing-to-fill')
  assert.equal($('#githubX').value, '')
})

test('shows an in-page banner with plain text', () => {
  page(MY_INFORMATION)
  run()
  const banner = document.getElementById('jobflow-workday-banner')!
  assert.ok(banner.textContent!.includes('已填入'))
  assert.equal(banner.querySelector('*'), null, 'no injected markup')
})

// ── Resume upload (separate explicit action) ────────────────

test('resume: uploads into the single file input', () => {
  page(`<div data-automation-id="progressBar"></div><input data-automation-id="file-upload-input-ref" type="file">`)
  let changed = 0
  document.querySelector('input[type=file]')!.addEventListener('change', () => changed++)
  const r = run('resume', PDF)
  assert.equal(r.status, 'uploaded')
  const files = ($('input[type=file]') as HTMLInputElement).files!
  assert.equal(files.length, 1)
  assert.equal(files[0].name, 'Ada_Resume.pdf')
  assert.equal(changed, 1)
})

test('resume: refuses when there are several file inputs', () => {
  page(`<div data-automation-id="progressBar"></div><input type="file" id="a"><input type="file" id="b">`)
  const r = run('resume', PDF)
  assert.equal(r.status, 'no-resume-input')
  assert.equal(($('#a') as HTMLInputElement).files?.length ?? 0, 0)
})

test('resume: explains when no PDF is saved', () => {
  page(`<div data-automation-id="progressBar"></div><input type="file">`)
  assert.equal(run('resume', null).status, 'no-resume-input')
})

test('fields mode never uploads a file', () => {
  page(`<div data-automation-id="progressBar"></div><input type="file" id="f">`)
  injected({ mode: 'fields', profile: PROFILE, resumePdf: PDF })
  assert.equal(($('#f') as HTMLInputElement).files?.length ?? 0, 0)
})

// ── Manifest: no automatic script on Workday, other ATS unchanged ──

test('manifest: content script excludes Workday and still covers other ATS', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  const cs = manifest.content_scripts[0]
  assert.ok(!cs.matches.some((m: string) => m.includes('myworkday')), 'Workday not in matches')
  assert.ok(cs.exclude_matches.includes('https://*.myworkdayjobs.com/*'))
  for (const host of ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'applytojob.com', 'oraclecloud.com']) {
    assert.ok(cs.matches.some((m: string) => m.includes(host)), `${host} still matched`)
  }
  assert.ok(manifest.permissions.includes('scripting'))
  assert.ok(manifest.host_permissions.includes('https://*.myworkdayjobs.com/*'), 'needed for user-triggered injection')
})
