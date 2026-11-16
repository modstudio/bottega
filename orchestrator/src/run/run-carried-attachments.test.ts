import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  carriedAttachmentsSection,
  carriedAttachmentTokens,
  resolveCarriedAttachments,
} from './run-carried-attachments.ts'
import { CARRIED_ATTACHMENT_MAX_BYTES, CARRIED_ATTACHMENTS_MAX_BYTES } from './run-pack-prompt.ts'

const FIRST = 'attached-text:11111111-1111-4111-8111-111111111111'
const SECOND = 'attached-text:22222222-2222-4222-8222-222222222222'
const THIRD = 'attached-text:33333333-3333-4333-8333-333333333333'

describe('carried attachment tokens', () => {
  test('collects distinct tokens across spec, rulings, and task text', () => {
    expect(
      carriedAttachmentTokens(
        `spec ${FIRST} ${SECOND}`,
        `rulings ${SECOND}`,
        `task ${THIRD} ${FIRST}`,
      ),
    ).toEqual([FIRST, SECOND, THIRD])
  })

  test('text without tokens yields none', () => {
    expect(carriedAttachmentTokens('plain spec', 'plain rulings', 'plain task')).toEqual([])
  })
})

describe('carried attachment rendering', () => {
  test('renders live and redirected entries', () => {
    const section = carriedAttachmentsSection([
      {
        kind: 'live',
        id: FIRST.slice('attached-text:'.length),
        cursor: 42,
        stepSlug: 'design',
        body: 'Exact body.\nKeep spacing.',
      },
      {
        kind: 'redirect',
        id: SECOND.slice('attached-text:'.length),
        documentReference: 'DEV-9/design-text',
      },
    ])
    expect(section).toContain(`${FIRST} — cursor 42, step design\n\nExact body.\nKeep spacing.`)
    expect(section).toContain(`${SECOND} — task document DEV-9/design-text`)
    expect(section).toContain(`read it with ${PLATFORM_SLUG} task doc show DEV-9/design-text`)
  })

  test('truncates one multibyte body on a UTF-8 boundary', () => {
    const section = carriedAttachmentsSection([
      {
        kind: 'live',
        id: FIRST.slice('attached-text:'.length),
        cursor: 42,
        stepSlug: 'design',
        body: 'é'.repeat(CARRIED_ATTACHMENT_MAX_BYTES),
      },
    ])
    const renderedBody = section.slice(section.indexOf('\n\n', section.indexOf(FIRST)) + 2)
    expect(Buffer.byteLength(renderedBody)).toBeLessThanOrEqual(CARRIED_ATTACHMENT_MAX_BYTES)
    expect(renderedBody).not.toContain('\uFFFD')
    expect(renderedBody).toContain(`${PLATFORM_SLUG} workflow text show ${FIRST}`)
  })

  test('truncates the section on a UTF-8 boundary and identifies the cut entry', () => {
    const section = carriedAttachmentsSection(
      [FIRST, SECOND, THIRD].map((token, index) => ({
        kind: 'live' as const,
        id: token.slice('attached-text:'.length),
        cursor: index + 1,
        stepSlug: `step-${index + 1}`,
        body: '界'.repeat(4_000),
      })),
    )
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(CARRIED_ATTACHMENTS_MAX_BYTES)
    expect(section).not.toContain('\uFFFD')
    expect(section).toContain(`${PLATFORM_SLUG} workflow text show ${THIRD}`)
  })
})

test('an unknown token refuses with its condition and remedy', async () => {
  await expect(
    resolveCarriedAttachments([`spec ${FIRST}`], {
      readAttachment: async () => {
        throw new Error(`${FIRST} is not held on this machine`)
      },
    }),
  ).rejects.toThrow(
    `carried attachments could not be resolved before dispatch:\n- ${FIRST}: not held on this machine\n` +
      `remedy: re-attach the text with ${PLATFORM_SLUG} workflow text or paste the body into the spec`,
  )
})
