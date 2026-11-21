import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'

export type DocumentRoleCandidate = {
  id: string
  number: number
  role: string | null
  title: string
  version: string
}

export function documentRoleRefusal(
  documents: DocumentRoleCandidate[],
  taskKey: string,
  requestedRole: string,
  writtenDocumentId?: string,
): string | null {
  const holder = documents.find(
    (document) => document.role === requestedRole && document.id !== writtenDocumentId,
  )
  if (!holder) return null
  const label = formatTaskDocumentLabel(taskKey, holder.number)
  return `role '${requestedRole}' on task ${taskKey} is held by ${label} "${holder.title}"; run \`${PLATFORM_SLUG} task doc set ${label} --no-role --version ${holder.version}\`, then retry`
}
