// concern: run carried attachments
/** Resolves workflow text references before a prompt enters the worker sandbox. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowTextAttachmentToken } from '../workflow/workflow-text.ts'
import { showWorkflowText } from '../workflow/workflow-text-copy.ts'
import { CARRIED_ATTACHMENT_MAX_BYTES, CARRIED_ATTACHMENTS_MAX_BYTES } from './run-pack-prompt.ts'

const ATTACHED_TEXT_PATTERN =
  /attached-text:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu

export type CarriedAttachment = Awaited<ReturnType<typeof showWorkflowText>>
type AttachmentReader = (token: string) => Promise<CarriedAttachment>

export function carriedAttachmentTokens(...sections: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const section of sections) {
    for (const match of section.matchAll(ATTACHED_TEXT_PATTERN)) tokens.add(match[0].toLowerCase())
  }
  return [...tokens]
}

function fitUtf8(value: string, bytes: number): string {
  if (bytes <= 0) return ''
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= bytes) return value
  return encoded
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
}

function truncationMarker(token: string, scope: 'attachment' | 'section'): string {
  return (
    `\n\n${scope === 'attachment' ? 'Attachment' : 'Carried attachments section'} truncated at ${token}; ` +
    `the architect can read the rest with ${PLATFORM_SLUG} workflow text show ${token}.`
  )
}

function bound(value: string, bytes: number, marker: string): string {
  if (Buffer.byteLength(value) <= bytes) return value
  if (Buffer.byteLength(marker) >= bytes) return fitUtf8(marker, bytes)
  return `${fitUtf8(value, bytes - Buffer.byteLength(marker))}${marker}`
}

function attachmentEntry(attachment: CarriedAttachment): string {
  const token = workflowTextAttachmentToken(attachment.id)
  if (attachment.kind === 'redirect') {
    return bound(
      `${token} — task document ${attachment.documentReference}\n\nread it with ${PLATFORM_SLUG} task doc show ${attachment.documentReference}`,
      CARRIED_ATTACHMENT_MAX_BYTES,
      truncationMarker(token, 'attachment'),
    )
  }
  const heading = `${token} — cursor ${attachment.cursor}, step ${attachment.stepSlug}`
  return bound(
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
    return `${section}${separator}${bound(
      entries[index]!,
      CARRIED_ATTACHMENTS_MAX_BYTES - Buffer.byteLength(section) - Buffer.byteLength(separator),
      marker,
    )}`
  }
  return section
}

function attachmentRefusal(failures: Array<{ token: string; condition: string }>): Error {
  const details = failures.map(({ token, condition }) => `- ${token}: ${condition}`).join('\n')
  return new Error(
    `carried attachments could not be resolved before dispatch:\n${details}\n` +
      `remedy: re-attach the text with ${PLATFORM_SLUG} workflow text or paste the body into the spec`,
  )
}

export async function resolveCarriedAttachments(
  sections: readonly string[],
  dependencies: { readAttachment?: AttachmentReader } = {},
): Promise<string> {
  const tokens = carriedAttachmentTokens(...sections)
  if (tokens.length === 0) return ''
  const readAttachment = dependencies.readAttachment ?? showWorkflowText
  const resolved: CarriedAttachment[] = []
  const failures: Array<{ token: string; condition: string }> = []
  for (const token of tokens) {
    try {
      resolved.push(await readAttachment(token))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      failures.push({
        token,
        condition: message.includes('is not held on this machine')
          ? 'not held on this machine'
          : 'the workflow text store is unreachable',
      })
    }
  }
  if (failures.length > 0) throw attachmentRefusal(failures)
  return carriedAttachmentsSection(resolved)
}
