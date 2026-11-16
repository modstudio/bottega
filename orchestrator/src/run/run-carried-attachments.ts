// concern: run carried attachments
/** Resolves workflow text references before a prompt enters the worker sandbox. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  workflowTextAttachmentToken,
  workflowTextAttachmentTokens,
} from '../workflow/workflow-text.ts'
import { showWorkflowText, WorkflowTextNotHeldError } from '../workflow/workflow-text-copy.ts'
import { boundUtf8, TASK_TEXT_MAX_BYTES } from './run-pack-prompt.ts'

export const CARRIED_ATTACHMENT_MAX_BYTES = TASK_TEXT_MAX_BYTES
export const CARRIED_ATTACHMENTS_MAX_BYTES = TASK_TEXT_MAX_BYTES * 2

export type CarriedAttachment = Awaited<ReturnType<typeof showWorkflowText>>
type AttachmentReader = (token: string) => Promise<CarriedAttachment>

export function carriedAttachmentTokens(...sections: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const section of sections) {
    for (const token of workflowTextAttachmentTokens(section)) tokens.add(token)
  }
  return [...tokens]
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

type AttachmentFailure = { token: string; condition: string; remedy: string }

function attachmentRefusal(failures: AttachmentFailure[]): Error {
  const details = failures
    .map(({ token, condition, remedy }) => `- ${token}: ${condition}\n  remedy: ${remedy}`)
    .join('\n')
  return new Error(`carried attachments could not be resolved before dispatch:\n${details}`)
}

export async function resolveCarriedAttachments(
  sections: readonly string[],
  dependencies: { readAttachment?: AttachmentReader } = {},
): Promise<string> {
  const tokens = carriedAttachmentTokens(...sections)
  if (tokens.length === 0) return ''
  const readAttachment = dependencies.readAttachment ?? showWorkflowText
  const resolved: CarriedAttachment[] = []
  const failures: AttachmentFailure[] = []
  for (const token of tokens) {
    try {
      resolved.push(await readAttachment(token))
    } catch (cause) {
      if (cause instanceof WorkflowTextNotHeldError) {
        failures.push({
          token,
          condition: 'not held on this machine',
          remedy: `re-attach the text with ${PLATFORM_SLUG} workflow attach or paste the body into the spec`,
        })
      } else {
        const message = cause instanceof Error ? cause.message : String(cause)
        failures.push({
          token,
          condition: `the workflow text store could not be read: ${message}`,
          remedy:
            'restore access to the workflow text store and retry dispatch, or paste the body into the spec',
        })
      }
    }
  }
  if (failures.length > 0) throw attachmentRefusal(failures)
  return carriedAttachmentsSection(resolved)
}
