import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  missingWorkflowTextMessage,
  WorkflowTextNotHeldError,
} from '../workflow/workflow-text-missing.ts'
import {
  CARRIED_ATTACHMENT_MAX_BYTES,
  CARRIED_ATTACHMENTS_MAX_BYTES,
  carriedAttachmentsSection,
  resolveCarriedAttachments,
} from './run-carried-attachments.ts'

const FIRST = 'attached-text:11111111-1111-4111-8111-111111111111'
const SECOND = 'attached-text:22222222-2222-4222-8222-222222222222'
const THIRD = 'attached-text:33333333-3333-4333-8333-333333333333'

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
  const missing = missingWorkflowTextMessage(FIRST, 'local-authoritative')
  await expect(
    resolveCarriedAttachments(
      [
        { label: 'spec', text: `spec ${FIRST}` },
        { label: 'task rulings (question Q)', text: `ruling ${FIRST}` },
      ],
      {
        readAttachment: async () => {
          throw new WorkflowTextNotHeldError(missing.condition, missing.remedy)
        },
      },
    ),
  ).rejects.toThrow(
    `carried attachments could not be resolved before dispatch:\n- ${FIRST} (from spec, task rulings (question Q)): ` +
      `${FIRST} has no live workflow text or copy link in this machine's store; ` +
      `an id attached on another machine is readable only through its task document.\n  remedy: re-attach the text with ${PLATFORM_SLUG} workflow attach, ` +
      "read another machine's attachment through its task document, or paste the body into the spec",
  )
})

test('a store failure carries its cause and a store remedy', async () => {
  await expect(
    resolveCarriedAttachments([{ label: 'spec', text: `spec ${FIRST}` }], {
      readAttachment: async () => {
        throw new Error('record service timed out')
      },
    }),
  ).rejects.toThrow(
    `- ${FIRST} (from spec): the workflow text store could not be read: record service timed out\n` +
      '  remedy: restore access to the workflow text store and retry dispatch, or paste the body into the spec',
  )
})

test('a store failure for a task-text-only token refuses instead of warning', async () => {
  const warnings: string[] = []
  await expect(
    resolveCarriedAttachments([{ label: 'task text', text: FIRST, missing: 'warn' }], {
      readAttachment: async () => {
        throw new Error('record service timed out')
      },
      onWarning: (warning) => warnings.push(warning),
    }),
  ).rejects.toThrow(
    `- ${FIRST} (from task text): the workflow text store could not be read: record service timed out\n` +
      '  remedy: restore access to the workflow text store and retry dispatch, or paste the body into the spec',
  )
  expect(warnings).toEqual([])
})

async function missingAttachmentResult(
  sections: Parameters<typeof resolveCarriedAttachments>[0],
): Promise<{ error: Error | null; warnings: string[] }> {
  const warnings: string[] = []
  const missing = missingWorkflowTextMessage(FIRST, 'local-authoritative')
  let error: Error | null = null
  try {
    await resolveCarriedAttachments(sections, {
      readAttachment: async () => {
        throw new WorkflowTextNotHeldError(missing.condition, missing.remedy)
      },
      onWarning: (warning) => warnings.push(warning),
    })
  } catch (cause) {
    error = cause as Error
  }
  return { error, warnings }
}

test('a dead token only in task text warns and does not refuse', async () => {
  const result = await missingAttachmentResult([
    { label: 'task text', text: FIRST, missing: 'warn' },
  ])

  expect(result.error).toBeNull()
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain(FIRST)
  expect(result.warnings[0]).toContain('from task text')
  const condition = missingWorkflowTextMessage(FIRST, 'local-authoritative').condition
  const section = await resolveCarriedAttachments(
    [{ label: 'task text', text: FIRST, missing: 'warn' }],
    {
      readAttachment: async () => {
        const missing = missingWorkflowTextMessage(FIRST, 'local-authoritative')
        throw new WorkflowTextNotHeldError(missing.condition, missing.remedy)
      },
    },
  )
  expect(section).toContain('CARRIED ATTACHMENTS')
  expect(section).toContain(`${FIRST} — unresolved (from task text)`)
  expect(section).toContain(condition)
})

test('a dead token in task text and the spec follows the stricter rule', async () => {
  const result = await missingAttachmentResult([
    { label: 'task text', text: FIRST, missing: 'warn' },
    { label: 'spec', text: FIRST },
  ])

  expect(result.error?.message).toContain(`from task text, spec`)
  expect(result.warnings).toEqual([])
})
