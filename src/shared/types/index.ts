// User profile and base resume
export interface UserProfile {
  name: string
  email: string
  phone: string
  location: string
  linkedinUrl: string
  githubUrl: string
  baseResumeText: string
  workerUrl: string      // Cloudflare Worker URL (API keys live server-side, not in the browser)
  workerToken: string    // bearer token for Worker calls
  sheetsId: string
  transcriptGpa: string
  transcriptSemester: string
  transcriptText: string
}

// Supported job sources
export type JobSource =
  | 'linkedin'
  | 'indeed'
  | 'simplify'
  | 'handshake'
  | 'greenhouse'
  | 'lever'
  | 'github'
  | 'generic'

// Job info extracted from a posting page
export interface JobInfo {
  id: string
  url: string
  company: string
  title: string
  location: string
  descriptionRaw: string
  detectedAt: string
  source: JobSource
}

// One application record
export interface Application {
  id: string
  job: JobInfo
  customizedResume: string
  appliedAt: string
  status: 'draft' | 'filled' | 'submitted'
}

// Form field keywords that indicate a transcript/GPA field
export const TRANSCRIPT_FIELD_KEYWORDS = [
  'gpa', 'grade point', 'transcript', 'academic record',
  'cumulative gpa', 'major gpa', 'unofficial transcript',
]

// Internal extension messages
export type Message =
  | { type: 'JD_DETECTED'; job: JobInfo }
  | { type: 'GENERATE_RESUME'; job: JobInfo }
  | { type: 'RESUME_READY'; resume: string; job: JobInfo }
  | { type: 'RESUME_ERROR'; error: string }
  | { type: 'FILL_FORM'; resume: string }
  | { type: 'APPLICATION_SUBMITTED'; job: JobInfo }
  | { type: 'GET_PROFILE' }
  | { type: 'PROFILE_RESULT'; profile: UserProfile | null }
  | { type: 'OPEN_SIDEBAR'; job: JobInfo }
