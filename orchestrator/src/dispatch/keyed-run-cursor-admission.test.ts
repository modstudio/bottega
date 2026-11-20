import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  checkKeyedRunCursorAdmission,
  decideKeyedRunCursorAdmission,
  keyedCursorOption,
} from './keyed-run-cursor-admission.ts'

const base = {
  turn: 'start' as const,
  key: 'DEV-2293',
  project: PLATFORM_SLUG,
  bindingPresent: false,
  harnessSession: 'session-fixture',
  heldCursors: [] as Array<{
    recordId: string
    number: number
    project: string
    workflowKey: string
    stepSlug: string
  }>,
  overrideReason: undefined,
  fromOperator: false,
}

describe('keyed run cursor admission', () => {
  test('the shared cursor option accepts only positive integers', () => {
    expect(keyedCursorOption(undefined)).toBeUndefined()
    expect(keyedCursorOption('4')).toBe(4)
    expect(() => keyedCursorOption('0')).toThrow('--cursor must be a positive integer')
    expect(() => keyedCursorOption('1.5')).toThrow('--cursor must be a positive integer')
  })

  test.each([
    ['keyless', { key: undefined }],
    ['unkeyed later turn', { turn: 'retry' as const, key: undefined }],
    ['workflow-bound', { bindingPresent: true }],
  ])('allows %s', (_name, change) => {
    expect(decideKeyedRunCursorAdmission({ ...base, ...change })).toEqual({ kind: 'allow' })
  })

  test('a keyed later turn with its cursor held is allowed', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        turn: 'continue',
        heldCursors: [
          {
            recordId: 'cursor-record',
            number: 17,
            project: PLATFORM_SLUG,
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
          },
        ],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'cursor-record', stepSlug: 'apply-findings' },
    })
  })

  test('a bound root held at a later step binds the new turn to that step', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        turn: 'continue',
        bindingPresent: true,
        rootCursorRecordId: 'cursor-record',
        heldCursors: [
          {
            recordId: 'cursor-record',
            number: 17,
            project: PLATFORM_SLUG,
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
          },
        ],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'cursor-record', stepSlug: 'apply-findings' },
    })
  })

  test('a bound root refuses --cursor naming a different cursor', () => {
    const decision = decideKeyedRunCursorAdmission({
      ...base,
      turn: 'continue',
      bindingPresent: true,
      rootCursorRecordId: 'cursor-record',
      cursor: 18,
      heldCursors: [
        {
          recordId: 'cursor-record',
          number: 17,
          project: PLATFORM_SLUG,
          workflowKey: 'DEV-2293',
          stepSlug: 'apply-findings',
        },
      ],
    })
    expect(decision).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('root is bound to workflow cursor 17, not cursor 18'),
    })
  })

  test('two matching cursors require --cursor and the selected cursor binds', () => {
    const heldCursors = [
      {
        recordId: 'cursor-17',
        number: 17,
        project: PLATFORM_SLUG,
        workflowKey: 'DEV-2293',
        stepSlug: 'implement-fix',
      },
      {
        recordId: 'cursor-18',
        number: 18,
        project: PLATFORM_SLUG,
        workflowKey: 'DEV-2293',
        stepSlug: 'review-lenses',
      },
    ]
    const ambiguous = decideKeyedRunCursorAdmission({ ...base, heldCursors })
    expect(ambiguous).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('--cursor <number>'),
    })
    expect(decideKeyedRunCursorAdmission({ ...base, heldCursors, cursor: 18 })).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'cursor-18', stepSlug: 'review-lenses' },
    })
  })

  test('a keyed later turn without its cursor is refused with every workflow remedy', () => {
    const decision = decideKeyedRunCursorAdmission({ ...base, turn: 'continue' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow compose plan-task --project ${PLATFORM_SLUG} --arg key=DEV-2293`,
    )
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow compose fix-defect --project ${PLATFORM_SLUG} --arg key=DEV-2293`,
    )
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow compose ship-task --project ${PLATFORM_SLUG} --arg key=DEV-2293 --arg branch=<branch> --arg worktree=<worktree>`,
    )
    expect(decision.message.indexOf('plan-task')).toBeLessThan(
      decision.message.indexOf('fix-defect'),
    )
    expect(decision.message.indexOf('fix-defect')).toBeLessThan(
      decision.message.indexOf('ship-task'),
    )
    expect(decision.message.indexOf('ship-task')).toBeLessThan(
      decision.message.indexOf('--override-unbound'),
    )
  })

  test('a keyed start without a session refuses unless it carries a cursor binding', () => {
    expect(decideKeyedRunCursorAdmission({ ...base, harnessSession: null })).toEqual({
      kind: 'refuse',
      message: expect.stringMatching(/without a harness session[\s\S]*run from a harness session/),
    })
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        harnessSession: null,
        bindingPresent: true,
      }),
    ).toEqual({ kind: 'allow' })
  })

  test.each([
    [
      'the key in another project',
      [
        {
          recordId: 'other-project',
          number: 17,
          project: 'segnavia',
          workflowKey: 'DEV-2293',
          stepSlug: 'start',
        },
      ],
    ],
    [
      'only a keyless cursor',
      [
        {
          recordId: 'keyless',
          number: 17,
          project: PLATFORM_SLUG,
          workflowKey: '',
          stepSlug: 'start',
        },
      ],
    ],
  ])('refuses a harness holding %s', (_name, heldCursors) => {
    expect(decideKeyedRunCursorAdmission({ ...base, heldCursors })).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        `harness session session-fixture does not hold an open workflow cursor for project ${PLATFORM_SLUG} and task DEV-2293`,
      ),
    })
  })

  test('allows an attributed override and returns its fixed warning text', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        overrideReason: 'Emergency dispatch approved.',
        fromOperator: true,
      }),
    ).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound keyed run turn overridden by Shmuel Barkin: Emergency dispatch approved.',
    })
  })

  test('refuses an override without operator attribution', () => {
    expect(
      decideKeyedRunCursorAdmission({ ...base, overrideReason: 'Emergency dispatch approved.' }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('--override-unbound "<reason>" --from-operator'),
    })
  })

  test('refuses an empty override reason', () => {
    expect(
      decideKeyedRunCursorAdmission({ ...base, overrideReason: '   ', fromOperator: true }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('--override-unbound requires a non-empty reason'),
    })
  })

  test('refuses outside every registered project with an actionable project remedy', () => {
    expect(decideKeyedRunCursorAdmission({ ...base, project: null })).toEqual({
      kind: 'refuse',
      message: expect.stringMatching(
        /outside every registered project[\s\S]*run the dispatch from inside the project's checkout or pass --repo <project>/,
      ),
    })
  })

  test('a later turn outside a registered project names only its available remedies', () => {
    const decision = decideKeyedRunCursorAdmission({ ...base, turn: 'answer', project: null })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow compose plan-task --project <project> --arg key=DEV-2293`,
    )
    expect(decision.message).not.toContain('--repo')
    expect(decision.message).not.toContain('--override-unbound')
  })

  test('a refused keyed answer names compose remedies but no override', () => {
    const decision = decideKeyedRunCursorAdmission({ ...base, turn: 'answer' })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain('workflow compose plan-task')
    expect(decision.message).toContain('workflow compose fix-defect')
    expect(decision.message).toContain('workflow compose ship-task')
    expect(decision.message).not.toContain('--override-unbound')
  })

  test('refuses when open cursors cannot be read and names the recovery', async () => {
    const decision = await checkKeyedRunCursorAdmission(
      (({ heldCursors: _heldCursors, ...input }) => input)(base),
      async () => {
        throw new Error('hosted store unavailable')
      },
    )

    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.message).toContain(
        'open workflow cursors for harness session session-fixture could not be read: hosted store unavailable',
      )
      expect(decision.message).toContain(`${PLATFORM_SLUG} machine doctor`)
    }
  })

  test('an attributed override does not require the cursor store to be reachable', async () => {
    let reads = 0
    const decision = await checkKeyedRunCursorAdmission(
      {
        ...(({ heldCursors: _heldCursors, ...input }) => input)(base),
        overrideReason: 'Emergency dispatch approved.',
        fromOperator: true,
      },
      async () => {
        reads += 1
        throw new Error('hosted store unavailable')
      },
    )

    expect(decision).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound keyed run turn overridden by Shmuel Barkin: Emergency dispatch approved.',
    })
    expect(reads).toBe(0)
  })
})
