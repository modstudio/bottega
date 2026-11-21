import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'

export const TASK_DOCUMENT_ROLES = ['handoff'] as const
export type TaskDocumentRole = (typeof TASK_DOCUMENT_ROLES)[number]

export type DocumentRoleCandidate = {
  id: string
  number: number
  role: TaskDocumentRole | null
  title: string
  version: string
}

export function documentRole(value: string | null | undefined): TaskDocumentRole | null {
  if (value == null) return null
  if (!(TASK_DOCUMENT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`invalid document role '${value}': expected ${TASK_DOCUMENT_ROLES.join('|')}`)
  }
  return value as TaskDocumentRole
}

export function documentRoleRefusal(
  documents: DocumentRoleCandidate[],
  taskKey: string,
  requestedRole: TaskDocumentRole,
  writtenDocumentId?: string,
): string | null {
  const holder = documents.find(
    (document) => document.role === requestedRole && document.id !== writtenDocumentId,
  )
  if (!holder) return null
  const label = formatTaskDocumentLabel(taskKey, holder.number)
  return `role '${requestedRole}' on task ${taskKey} is held by ${label} "${holder.title}"; run \`${PLATFORM_SLUG} task doc set ${label} --no-role --version ${holder.version}\`, then retry`
}
