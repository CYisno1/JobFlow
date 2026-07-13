import type { UserProfile, Application } from './types'

// User profile
export async function getProfile(): Promise<UserProfile | null> {
  const result = await chrome.storage.local.get('profile')
  return (result.profile as UserProfile) ?? null
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.local.set({ profile })
}

// Application records
export async function getApplications(): Promise<Application[]> {
  const result = await chrome.storage.local.get('applications')
  return (result.applications as Application[]) ?? []
}

export async function addApplication(app: Application): Promise<void> {
  const existing = await getApplications()
  await chrome.storage.local.set({ applications: [app, ...existing] })
}

// Resume PDF (base64)
export async function saveResumePdf(base64: string, name: string): Promise<void> {
  await chrome.storage.local.set({ resumePdf: { base64, name } })
}

export async function getResumePdf(): Promise<{ base64: string; name: string } | null> {
  const result = await chrome.storage.local.get('resumePdf')
  return (result.resumePdf as { base64: string; name: string }) ?? null
}
