import { recordApiUrl } from './hub-mode.ts'

export type OrganizationRole = 'owner' | 'admin' | 'member'
export type OrganizationMember = {
  id: string
  userId: string
  organizationId: string
  role: OrganizationRole
  user: { name: string; email: string }
}
export type OrganizationInvitation = {
  id: string
  email: string
  role: OrganizationRole
  organizationId: string
  inviterId: string
  status: string
  expiresAt: string
}
export type InvitationDetail = OrganizationInvitation & {
  organizationName: string
  organizationSlug: string
  inviterEmail: string
}

export class OrganizationRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function organizationUrl(path: string) {
  const base = recordApiUrl()
  if (!base) throw new Error('VITE_RECORD_API_URL is required')
  return `${base}/api/auth${path}`
}

function errorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const value = body as Record<string, unknown>
  if (typeof value.message === 'string' && value.message) return value.message
  if (value.error && typeof value.error === 'object') {
    const error = value.error as Record<string, unknown>
    if (typeof error.message === 'string' && error.message) return error.message
  }
  return fallback
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(organizationUrl(path), {
    ...init,
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new OrganizationRequestError(
      errorMessage(body, 'The request could not be completed'),
      response.status,
    )
  }
  return body as T
}

const post = <T>(path: string, body: Record<string, unknown>) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export async function recordAuthSession() {
  return request<{
    user: { email: string; name: string }
    session: Record<string, unknown>
  } | null>('/get-session')
}

export async function listOrganizationMembers() {
  return request<{ members: OrganizationMember[]; total: number }>('/organization/list-members')
}

export async function activeOrganizationMember() {
  return request<OrganizationMember>('/organization/get-active-member')
}

export async function listOrganizationInvitations() {
  return request<OrganizationInvitation[]>('/organization/list-invitations')
}

export async function inviteOrganizationMember(
  email: string,
  role: OrganizationRole,
  resend = false,
) {
  return post<OrganizationInvitation>('/organization/invite-member', { email, role, resend })
}

export async function updateOrganizationMemberRole(id: string, role: OrganizationRole) {
  return post<OrganizationMember>('/organization/update-member-role', { memberId: id, role })
}

export async function removeOrganizationMember(id: string) {
  return post<{ member: OrganizationMember }>('/organization/remove-member', {
    memberIdOrEmail: id,
  })
}

export async function cancelOrganizationInvitation(id: string) {
  return post<OrganizationInvitation>('/organization/cancel-invitation', { invitationId: id })
}

export async function getOrganizationInvitation(id: string) {
  return request<InvitationDetail>(`/organization/get-invitation?id=${encodeURIComponent(id)}`)
}

export async function acceptOrganizationInvitation(id: string) {
  return post<{ invitation: OrganizationInvitation }>('/organization/accept-invitation', {
    invitationId: id,
  })
}

export async function rejectOrganizationInvitation(id: string) {
  return post('/organization/reject-invitation', { invitationId: id })
}

export async function setActiveOrganization(id: string) {
  return post('/organization/set-active', { organizationId: id })
}

export async function signUpForRecord(name: string, email: string, password: string) {
  return post('/sign-up/email', { name, email, password })
}
