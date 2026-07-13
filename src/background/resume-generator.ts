import type { UserProfile, JobInfo } from '../shared/types'

/**
 * All AI calls go through the Cloudflare Worker proxy.
 * Prompts are built locally (personal data stays in the browser);
 * the API key lives in the Worker's environment, never here.
 */

// Non-streaming call: returns the full result at once
async function callWorker(profile: UserProfile, prompt: string): Promise<string> {
  const res = await fetch(`${workerBase(profile)}/api/generate`, {
    method: 'POST',
    headers: workerHeaders(profile),
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error(await workerError(res))
  const data = await res.json() as { text?: string }
  return data.text ?? ''
}

// Streaming call: SSE passed through from Claude, chunks arrive as they generate
async function streamWorker(
  profile: UserProfile,
  prompt: string,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const res = await fetch(`${workerBase(profile)}/api/generate`, {
    method: 'POST',
    headers: workerHeaders(profile),
    body: JSON.stringify({ prompt, stream: true }),
  })
  if (!res.ok) throw new Error(await workerError(res))

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue
      try {
        // Claude SSE: content_block_delta events carry the new text in delta.text
        const chunk: string = JSON.parse(data).delta?.text ?? ''
        if (chunk) { fullText += chunk; onChunk(chunk) }
      } catch { /* ignore non-JSON lines (event: headers etc.) */ }
    }
  }
  return fullText
}

// ── Worker connection helpers ─────────────────────────────
function workerBase(profile: UserProfile): string {
  return profile.workerUrl.trim().replace(/\/+$/, '')
}

function workerHeaders(profile: UserProfile): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${profile.workerToken.trim()}`,
  }
}

async function workerError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: string }
    return data.error ?? `Worker error ${res.status}`
  } catch {
    return `Worker error ${res.status}`
  }
}

// Type predicate: narrows in the true branch only — the false branch still
// includes valid profiles that simply lack Worker config (see service-worker).
export function hasWorkerConfig(profile: UserProfile | null): profile is UserProfile {
  return Boolean(profile?.workerUrl && profile?.workerToken)
}

// ── Prompt builders (local: the resume data lives in the browser) ──
function buildPrompt(profile: UserProfile, job: JobInfo): string {
  const transcriptNote = profile.transcriptGpa
    ? `\nLatest GPA: ${profile.transcriptGpa} (${profile.transcriptSemester})`
    : ''

  return `You are an expert resume writer specializing in tech internship and new-grad applications. Tailor the candidate's resume precisely to the job posting below.

=== JOB POSTING ===
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}

Full Job Description:
${job.descriptionRaw.slice(0, 8000)}

=== CANDIDATE'S BASE RESUME ===
${profile.baseResumeText}${transcriptNote}

=== INSTRUCTIONS ===
1. Write a targeted OBJECTIVE/SUMMARY (2-3 sentences) that mentions the company name, role, and 2-3 specific skills from the JD
2. Reorder and reword bullet points to front-load the most relevant experiences for THIS role
3. Naturally weave in exact keywords and tech stack from the JD (for ATS scanning) — do NOT force irrelevant keywords
4. Keep every fact accurate — do NOT fabricate projects, skills, or experiences
5. If the JD mentions specific tools/languages the candidate has (based on resume), highlight them prominently
6. Remove or minimize experiences clearly unrelated to this role
7. Output a complete 1-page resume in plain text, ready to paste into any form
8. Write in English

Output ONLY the resume text, no explanations or commentary.`
}

function buildCoverLetterPrompt(profile: UserProfile, job: JobInfo): string {
  return `You are an expert cover letter writer for tech internship applications. Write a concise, compelling cover letter.

=== JOB POSTING ===
Company: ${job.company}
Title: ${job.title}

Full Job Description:
${job.descriptionRaw.slice(0, 6000)}

=== CANDIDATE'S BASE RESUME ===
${profile.baseResumeText}

=== INSTRUCTIONS ===
1. Keep it under 250 words, 3 short paragraphs
2. Paragraph 1: Hook — mention the specific role and one concrete reason you're excited about THIS company (reference something specific from the JD or company)
3. Paragraph 2: Value — pick the 2 most relevant experiences/projects and connect them directly to the JD requirements
4. Paragraph 3: Close — brief call to action, enthusiastic but not sycophantic
5. Do NOT use "I am writing to apply for" — start with something engaging
6. Match keywords from the JD naturally
7. Write in English, professional but genuine tone

Output ONLY the cover letter text. Start with "Dear Hiring Manager,"`
}

// ── Public API (signatures unchanged across the proxy migration) ──
export async function scoreJobMatch(
  profile: UserProfile,
  job: JobInfo,
): Promise<number> {
  if (!hasWorkerConfig(profile)) return 50
  const prompt = `Rate how well this candidate matches this job on a scale of 0-100. Reply with ONLY a number.

Candidate skills summary: ${profile.baseResumeText.slice(0, 500)}

Job: ${job.title} at ${job.company}
Description (first 300 chars): ${job.descriptionRaw.slice(0, 300)}`
  try {
    const res = await callWorker(profile, prompt)
    const score = parseInt(res.trim(), 10)
    return isNaN(score) ? 50 : Math.min(100, Math.max(0, score))
  } catch {
    return 50
  }
}

export async function generateCustomResume(
  profile: UserProfile,
  job: JobInfo,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (!hasWorkerConfig(profile)) throw new Error('請先在設定頁填入 Worker 網址和 Token')
  const prompt = buildPrompt(profile, job)
  if (onChunk) return streamWorker(profile, prompt, onChunk)
  return callWorker(profile, prompt)
}

export async function generateCoverLetter(
  profile: UserProfile,
  job: JobInfo,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (!hasWorkerConfig(profile)) throw new Error('請先在設定頁填入 Worker 網址和 Token')
  const prompt = buildCoverLetterPrompt(profile, job)
  if (onChunk) return streamWorker(profile, prompt, onChunk)
  return callWorker(profile, prompt)
}
