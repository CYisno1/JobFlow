/**
 * JobFlow — Google Sheet ledger clerk (Apps Script).
 *
 * Since phase 2 the crawler lives in a Cloudflare Worker; this script only
 * keeps the Sheet ledger: it receives batches from the Worker via doPost
 * and records applications. fetchNewGradJobs() is kept as a manual fallback.
 *
 * After pasting a new version: run deleteTriggers() once (the Worker owns
 * scheduling now), then redeploy via Deploy → Manage deployments → New version.
 *
 * NOTE: sheet tab names, column headers and status values are intentionally
 * in Chinese — they must match the actual spreadsheet contents.
 */

// ═══════════════ Config (only place to touch when seasons change) ═══════════════

const SIMPLIFY_REPO   = 'SimplifyJobs/New-Grad-Positions';
const SIMPLIFY_BRANCH = 'dev';
const SPEEDY_REPO     = 'speedyapply/2027-SWE-College-Jobs';
const SPEEDY_FILE     = 'NEW_GRAD_USA.md';

const SIMPLIFY_JSON_URL = 'https://raw.githubusercontent.com/' + SIMPLIFY_REPO + '/' + SIMPLIFY_BRANCH + '/.github/scripts/listings.json';
const SPEEDY_MD_URL     = 'https://raw.githubusercontent.com/' + SPEEDY_REPO + '/main/' + SPEEDY_FILE;

// Include a job when title+category matches any keyword
const KEYWORDS = [
  'software', 'engineer', 'developer', 'data', 'machine learning',
  'full stack', 'fullstack', 'full-stack', 'backend', 'back end', 'back-end',
  'frontend', 'front end', 'front-end', 'mobile', 'infrastructure',
  'platform', 'devops', 'cloud', 'security', 'quant',
];
// Short acronyms use word boundaries (so "ml" doesn't match "html")
const KEYWORDS_SHORT_RE = /\b(swe|sde|ml|ai|ios|android)\b/i;
// Exclude on any match (\b keeps "intern" from matching "international")
const EXCLUDE_RE = /\b(senior|sr|staff|principal|lead|manager|director|intern|internship|internships|phd)\b/i;

// Sheet tab names and headers (Chinese = live data in the spreadsheet)
const JOBS_SHEET_NAME = 'New Grad 職缺';
const JOBS_HEADERS    = ['日期', '公司', '職位', '地點', '薪資', '來源', '狀態', '申請連結', 'ID'];
const APPS_SHEET_NAME = '投遞紀錄';
const APPS_HEADERS    = ['日期', '公司', '職稱', '申請連結', '狀態'];

// ═══════════════ Manual fallback crawler (Worker owns the schedule now) ═══════════════

function fetchNewGradJobs() {
  const sheet = getSheet_(JOBS_SHEET_NAME, JOBS_HEADERS);

  // Build in-memory indexes of existing rows (read once, compare in memory)
  const seenIds  = new Set();
  const urlIndex = new Map();   // normalized URL → { row, hasSalary, status }
  const idIndex  = new Map();   // id → { row, status }

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    data.forEach(function(r, i) {
      if (String(r[0]).startsWith('──')) return;   // skip timestamp separator rows
      const row = i + 2;
      const id = String(r[8] || '');
      if (id) { seenIds.add(id); idIndex.set(id, { row: row, status: String(r[6] || '') }); }
      if (r[7]) urlIndex.set(normalizeUrl_(String(r[7])), { row: row, hasSalary: !!r[4], status: String(r[6] || '') });
    });
  }

  const today = new Date().toLocaleDateString('zh-TW');
  const newRows = [];
  const newRowByUrl = new Map();   // this batch: URL → newRows index (cross-source salary merge)

  // Source 1 (primary): Simplify listings.json
  try {
    const res = UrlFetchApp.fetch(SIMPLIFY_JSON_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const listings = JSON.parse(res.getContentText());
      let added = 0, closed = 0;

      for (const job of listings) {
        if (!matchesKeywords_(job.title + ' ' + (job.category || ''))) continue;

        if (seenIds.has(job.id)) {
          // Known job: mark closure in the sheet
          if (job.active === false) {
            const info = idIndex.get(job.id);
            if (info && info.status !== '已關閉' && info.status !== '已投遞') {
              sheet.getRange(info.row, 7).setValue('已關閉');
              closed++;
            }
          }
          continue;
        }
        // New job: only take open + visible ones
        if (job.active !== true || job.is_visible === false) continue;

        const norm = normalizeUrl_(job.url);
        if (urlIndex.has(norm) || newRowByUrl.has(norm)) continue;

        newRows.push([today, job.company_name, job.title,
          (job.locations || []).join('; '), '', 'simplify', '', job.url, job.id]);
        newRowByUrl.set(norm, newRows.length - 1);
        added++;
      }
      console.log('Simplify: total ' + listings.length + ', added ' + added + ', closed ' + closed);
    } else {
      console.error('Simplify HTTP ' + res.getResponseCode());
    }
  } catch (e) {
    console.error('Simplify source error: ' + e);
  }

  // Source 2 (secondary): speedyapply markdown table
  try {
    const res = UrlFetchApp.fetch(SPEEDY_MD_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const jobs = parseSpeedyMarkdown_(res.getContentText());
      let added = 0, backfilled = 0;

      for (const job of jobs) {
        if (!matchesKeywords_(job.title)) continue;
        const norm = normalizeUrl_(job.url);

        // Cross-source duplicate: keep the Simplify row, backfill salary
        if (newRowByUrl.has(norm)) {
          const idx = newRowByUrl.get(norm);
          if (!newRows[idx][4] && job.salary) { newRows[idx][4] = job.salary; backfilled++; }
          continue;
        }
        if (urlIndex.has(norm)) {
          const info = urlIndex.get(norm);
          if (!info.hasSalary && job.salary) {
            sheet.getRange(info.row, 5).setValue(job.salary);
            backfilled++;
          }
          continue;
        }
        // speedyapply has no unique id — use the normalized URL
        newRows.push([today, job.company, job.title, job.location,
          job.salary, 'speedyapply', '', job.url, norm]);
        newRowByUrl.set(norm, newRows.length - 1);
        added++;
      }
      console.log('speedyapply: parsed ' + jobs.length + ', added ' + added + ', backfilled ' + backfilled);
    } else {
      console.error('speedyapply HTTP ' + res.getResponseCode());
    }
  } catch (e) {
    console.error('speedyapply source error: ' + e);
  }

  // Write to the sheet (timestamp separator + new rows)
  if (newRows.length > 0) {
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
    const sepText = '── ' + timestamp + '　新增 ' + newRows.length + ' 筆職缺 ──';
    const sepRow = sheet.getLastRow() + 1;

    sheet.getRange(sepRow, 1, 1, 9).setValues([[sepText, '', '', '', '', '', '', '', '']]);
    sheet.getRange(sepRow, 1, 1, 9).merge()
      .setBackground('#eef0ff').setFontColor('#6366f1')
      .setFontWeight('bold').setHorizontalAlignment('center');

    sheet.getRange(sepRow + 1, 1, newRows.length, 9).setValues(newRows);
  }
  console.log('done, added ' + newRows.length);
}

// Legacy name kept so old triggers still resolve
function fetchGithubJobs() { fetchNewGradJobs(); }

// ═══════════════ speedyapply markdown parsing ═══════════════
// Machine-generated table, fixed shape:
//   FAANG+/Quant: | company | title | location | salary | apply | age |
//   Other:        | company | title | location | apply | age |
function parseSpeedyMarkdown_(md) {
  const jobs = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || line.indexOf('href=') === -1) continue;

    const cells = line.split('|').slice(1, -1).map(function(c) { return c.trim(); });
    if (cells.length < 5) continue;

    const hasSalary = cells.length >= 6;
    const company   = stripTags_(cells[0]);
    const title     = stripTags_(cells[1]);
    const location  = stripTags_(cells[2]);
    const salary    = hasSalary ? stripTags_(cells[3]) : '';
    const applyCell = hasSalary ? cells[4] : cells[3];

    const m = applyCell.match(/href="(https?:\/\/[^"]+)"/);
    if (!m || !company || !title) continue;

    jobs.push({ company: company, title: title, location: location, salary: salary, url: m[1] });
  }
  return jobs;
}

// ═══════════════ Utilities ═══════════════

function stripTags_(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Normalize URLs so variants of the same job become one key:
// drop fragments, tracking params and trailing slashes; lowercase.
function normalizeUrl_(url) {
  let u = String(url).trim().replace(/#.*$/, '');
  const qIdx = u.indexOf('?');
  let base = qIdx === -1 ? u : u.slice(0, qIdx);
  let keep = '';
  if (qIdx !== -1) {
    const params = u.slice(qIdx + 1).split('&').filter(function(p) {
      return !/^(utm_|ref=|ref_|source=|src=|gh_src=|lever-origin=|origin=)/i.test(p);
    });
    if (params.length > 0) keep = '?' + params.sort().join('&');
  }
  return (base.replace(/\/+$/, '') + keep).toLowerCase();
}

function matchesKeywords_(text) {
  const t = String(text).toLowerCase();
  if (EXCLUDE_RE.test(t)) return false;
  if (KEYWORDS.some(function(kw) { return t.indexOf(kw) !== -1; })) return true;
  return KEYWORDS_SHORT_RE.test(t);
}

// Get (or create) a sheet tab with headers
function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold')
      .setBackground('#4a4a8a').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ═══════════════ Triggers ═══════════════

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fetchNewGradJobs').timeBased().everyMinutes(30).create();
  console.log('Trigger created!');
}

// Run once after phase 2: the Worker owns crawling now
function deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  console.log('All triggers deleted — crawling is handled by the Cloudflare Worker');
}

// ═══════════════ Webhook: Worker/Extension ⇄ Sheet ═══════════════

// POST payloads:
//   { type: 'jobs', jobs: [...], closedIds: [...] }  batch write from the Worker crawler
//   { type: 'application', company, title, url }     record a submission + update job status
//   anything else (legacy)                           append to the jobs sheet
function doPost(e) {
  try {
    const data = JSON.parse(e.postData ? e.postData.contents : '{}');
    const today = new Date().toLocaleDateString('zh-TW');

    // Worker crawler batch (defensive dedupe: a resent batch must not duplicate rows)
    if (data.type === 'jobs') {
      handleWorkerJobs_(data);
      return ok_();
    }

    if (data.type === 'application') {
      const sheet = getSheet_(APPS_SHEET_NAME, APPS_HEADERS);

      // Idempotent: same link on the same day records once
      const norm = normalizeUrl_(data.url || '');
      const last = sheet.getLastRow();
      if (last > 1) {
        const start = Math.max(2, last - 199);
        const rows = sheet.getRange(start, 1, last - start + 1, 4).getValues();
        for (const r of rows) {
          if (String(r[0]) === today && normalizeUrl_(String(r[3])) === norm) return ok_();
        }
      }
      sheet.appendRow([today, data.company || '', data.title || '', data.url || '', '已投遞']);

      // Keep the jobs sheet in sync (single source of truth)
      try {
        const jobsSheet = getSheet_(JOBS_SHEET_NAME, JOBS_HEADERS);
        const found = jobsSheet.createTextFinder(String(data.url || '')).matchEntireCell(true).findNext();
        if (found) jobsSheet.getRange(found.getRow(), 7).setValue('已投遞');
      } catch (err) {}

      return ok_();
    }

    // Legacy format
    const sheet = getSheet_(JOBS_SHEET_NAME, JOBS_HEADERS);
    sheet.appendRow([data.date || today, data.company || '', data.title || '',
      data.location || '', '', 'extension', '', data.url || '', normalizeUrl_(data.url || '')]);
    return ok_();
  } catch (err) {
    return ok_();
  }
}

// ═══════════ Worker batch write handler ═══════════
// The Worker already dedupes; this re-check is defensive so a retried/resent
// batch can never create duplicate rows (consumers must be idempotent).
function handleWorkerJobs_(data) {
  const sheet = getSheet_(JOBS_SHEET_NAME, JOBS_HEADERS);
  const today = new Date().toLocaleDateString('zh-TW');

  const seenIds = new Set();
  const seenUrls = new Set();
  const idIndex = new Map();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    rows.forEach(function(r, i) {
      if (String(r[0]).startsWith('──')) return;
      const id = String(r[8] || '');
      if (id) { seenIds.add(id); idIndex.set(id, { row: i + 2, status: String(r[6] || '') }); }
      if (r[7]) seenUrls.add(normalizeUrl_(String(r[7])));
    });
  }

  // Mark closed jobs
  (data.closedIds || []).forEach(function(id) {
    const info = idIndex.get(String(id));
    if (info && info.status !== '已關閉' && info.status !== '已投遞') {
      sheet.getRange(info.row, 7).setValue('已關閉');
    }
  });

  // Append new jobs (skip existing)
  const newRows = [];
  (data.jobs || []).forEach(function(j) {
    const id = String(j.id || '');
    const norm = normalizeUrl_(String(j.url || ''));
    if ((id && seenIds.has(id)) || seenUrls.has(norm)) return;
    newRows.push([today, j.company || '', j.title || '', j.location || '',
      j.salary || '', j.source || 'worker', '', j.url || '', id || norm]);
    if (id) seenIds.add(id);
    seenUrls.add(norm);
  });

  if (newRows.length > 0) {
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
    const sepText = '── ' + timestamp + '　Worker 新增 ' + newRows.length + ' 筆職缺 ──';
    const sepRow = sheet.getLastRow() + 1;
    sheet.getRange(sepRow, 1, 1, 9).setValues([[sepText, '', '', '', '', '', '', '', '']]);
    sheet.getRange(sepRow, 1, 1, 9).merge()
      .setBackground('#eef0ff').setFontColor('#6366f1')
      .setFontWeight('bold').setHorizontalAlignment('center');
    sheet.getRange(sepRow + 1, 1, newRows.length, 9).setValues(newRows);
  }
}

// GET: ?action=summary → stats JSON for the popup; anything else → health check
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'summary') {
    return ContentService.createTextOutput(JSON.stringify(buildSummary_()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('JobFlow webhook is running!');
}

function ok_() {
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

// Stats: totals + latest 15 open, un-applied jobs
function buildSummary_() {
  const jobsSheet = getSheet_(JOBS_SHEET_NAME, JOBS_HEADERS);
  const appsSheet = getSheet_(APPS_SHEET_NAME, APPS_HEADERS);

  let jobsTotal = 0, jobsOpen = 0;
  const latest = [];

  const lastRow = jobsSheet.getLastRow();
  if (lastRow > 1) {
    const data = jobsSheet.getRange(2, 1, lastRow - 1, 9).getValues();
    for (const r of data) {
      if (String(r[0]).startsWith('──')) continue;
      jobsTotal++;
      if (String(r[6]) !== '已關閉') jobsOpen++;
    }
    // Walk from the bottom (newest) for 15 open, un-applied jobs
    for (let i = data.length - 1; i >= 0 && latest.length < 15; i--) {
      const r = data[i];
      if (String(r[0]).startsWith('──')) continue;
      if (String(r[6]) === '已關閉' || String(r[6]) === '已投遞') continue;
      latest.push({
        date: String(r[0]), company: String(r[1]), title: String(r[2]),
        location: String(r[3]), salary: String(r[4]), source: String(r[5]), url: String(r[7]),
      });
    }
  }

  const statusCount = {};
  const appLast = appsSheet.getLastRow();
  if (appLast > 1) {
    const rows = appsSheet.getRange(2, 5, appLast - 1, 1).getValues();
    for (const r of rows) {
      const s = String(r[0] || '已投遞');
      statusCount[s] = (statusCount[s] || 0) + 1;
    }
  }

  return {
    ok: true,
    stats: {
      jobsTotal: jobsTotal,
      jobsOpen: jobsOpen,
      applied: appLast > 1 ? appLast - 1 : 0,
      byStatus: statusCount,
    },
    jobs: latest,
    updatedAt: new Date().toISOString(),
  };
}
