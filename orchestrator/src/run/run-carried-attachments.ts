// concern: run carried attachments
/** Resolves workflow text references before a prompt enters the worker sandbox. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  workflowTextAttachmentToken,
  workflowTextAttachmentTokens,
} from '../workflow/workflow-text.ts'
import { showWorkflowText } from '../workflow/workflow-text-copy.ts'
import { WorkflowTextNotHeldError } from '../workflow/workflow-text-missing.ts'
import { boundUtf8, TASK_TEXT_MAX_BYTES } from './run-pack-prompt.ts'

export const CARRIED_ATTACHMENT_MAX_BYTES = TASK_TEXT_MAX_BYTES
export const CARRIED_ATTACHMENTS_MAX_BYTES = TASK_TEXT_MAX_BYTES * 2

export type CarriedAttachment = Awaited<ReturnType<typeof showWorkflowText>>
type AttachmentReader = (token: string) => Promise<CarriedAttachment>

export type CarriedAttachmentSource = {
  label: string
  text: string
  missing?: 'refuse' | 'warn'
}
type CarriedAttachmentCandidate = { token: string; sources: string[]; refusalRequired: boolean }

function carriedAttachmentCandidates(
  sections: readonly CarriedAttachmentSource[],
): CarriedAttachmentCandidate[] {
  const tokens = new Map<string, { sources: string[]; refusalRequired: boolean }>()
  for (const section of sections) {
    for (const token of workflowTextAttachmentTokens(section.text)) {
      const candidate = tokens.get(token) ?? { sources: [], refusalRequired: false }
      if (!candidate.sources.includes(section.label)) candidate.sources.push(section.label)
      if (section.missing !== 'warn') candidate.refusalRequired = true
      tokens.set(token, candidate)
    }
  }
  return [...tokens].map(([token, candidate]) => ({ token, ...candidate }))
}

function truncationMarker(token: string, scope: 'attachment' | 'section'): string {
  return (
    `\n\n${scope === 'attachment' ? 'Attachment' : 'Carried attachments section'} truncated at ${token}; ` +
    `the architect can read the rest with ${PLATFORM_SLUG} workflow text show ${token}.`
  )
}

function attachmentEntry(attachment: CarriedAttachment): string {
  const token = workflowTextAttachmentToken(attachment.id)
  if (attachment.kind === 'redirect') {
    return boundUtf8(
      `${token} — task document ${attachment.documentReference}\n\nread it with ${PLATFORM_SLUG} task doc show ${attachment.documentReference}`,
      CARRIED_ATTACHMENT_MAX_BYTES,
      truncationMarker(token, 'attachment'),
    )
  }
  const heading = `${token} — cursor ${attachment.cursor}, step ${attachment.stepSlug}`
  return boundUtf8(
    `${heading}\n\n${attachment.body}`,
    CARRIED_ATTACHMENT_MAX_BYTES,
    truncationMarker(token, 'attachment'),
  )
}

export function carriedAttachmentsSection(attachments: readonly CarriedAttachment[]): string {
  if (attachments.length === 0) return ''
  const heading = 'CARRIED ATTACHMENTS'
  const entries = attachments.map(attachmentEntry)
  const full = `${heading}\n\n${entries.join('\n\n')}`
  if (Buffer.byteLength(full) <= CARRIED_ATTACHMENTS_MAX_BYTES) return full

  let section = heading
  for (let index = 0; index < entries.length; index += 1) {
    const separator = '\n\n'
    const candidate = `${section}${separator}${entries[index]}`
    if (Buffer.byteLength(candidate) <= CARRIED_ATTACHMENTS_MAX_BYTES) {
      section = candidate
      continue
    }
    const token = workflowTextAttachmentToken(attachments[index]!.id)
    const marker = truncationMarker(token, 'section')
    return boundUtf8(candidate, CARRIED_ATTACHMENTS_MAX_BYTES, marker)
  }
  return section
}

type AttachmentFailure = {
  token: string
  sources: string[]
  condition: string
  remedy: string
}

function attachmentRefusal(failures: AttachmentFailure[]): Error {
  const details = failures
    .map(
      ({ token, sources, condition, remedy }) =>
        `- ${token} (from ${sources.join(', ')}): ${condition}\n  remedy: ${remedy}`,
    )
    .join('\n')
  return new Error(`carried attachments could not be resolved before dispatch:\n${details}`)
}

function attachmentWarning({ token, sources, condition, remedy }: AttachmentFailure): string {
  return (
    `carried attachment ${token} (from ${sources.join(', ')}) could not be resolved: ${condition}\n` +
    `remedy: ${remedy}`
  )
}

function attachmentFailure(cause: unknown, token: string, sources: string[]): AttachmentFailure {
  if (cause instanceof WorkflowTextNotHeldError) {
    return { token, sources, condition: cause.condition, remedy: cause.remedy }
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return {
    token,
    sources,
    condition: `the workflow text store could not be read: ${message}`,
    remedy:
      'restore access to the workflow text store and retry dispatch, or paste the body into the spec',
  }
}

export async function resolveCarriedAttachments(
  sections: readonly CarriedAttachmentSource[],
  dependencies: { readAttachment?: AttachmentReader; onWarning?: (warning: string) => void } = {},
): Promise<string> {
  const carriedTokens = carriedAttachmentCandidates(sections)
  if (carriedTokens.length === 0) return ''
  const readAttachment = dependencies.readAttachment ?? showWorkflowText
  const resolved: CarriedAttachment[] = []
  const failures: AttachmentFailure[] = []
  for (const { token, sources, refusalRequired } of carriedTokens) {
    try {
      resolved.push(await readAttachment(token))
    } catch (cause) {
      const failure = attachmentFailure(cause, token, sources)
      if (cause instanceof WorkflowTextNotHeldError && !refusalRequired)
        dependencies.onWarning?.(attachmentWarning(failure))
      else failures.push(failure)
    }
  }
  if (failures.length > 0) throw attachmentRefusal(failures)
  return carriedAttachmentsSection(resolved)
}
