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
  writesRepo: false,
  harnessSession: 'session-fixture',
  heldCursors: [] as Array<{
    recordId: string
    number: number
    project: string
    workflowSlug: string
    workflowKey: string
    stepSlug: string
    updatedAt: string
  }>,
  overrideReason: undefined,
  fromOperator: false,
  overridePersonName: null,
}

const keylessCursor = (
  number: number,
  updatedAt = '2026-11-20T12:00:00.000Z',
  project = PLATFORM_SLUG,
) => ({
  recordId: `keyless-${number}`,
  number,
  project,
  workflowSlug: 'explore',
  workflowKey: '',
  stepSlug: 'explore',
  updatedAt,
})

describe('keyed run cursor admission', () => {
  test('the shared cursor option accepts only positive integers', () => {
    expect(keyedCursorOption(undefined)).toBeUndefined()
    expect(keyedCursorOption('4')).toBe(4)
    expect(() => keyedCursorOption('0')).toThrow('--cursor must be a positive integer')
    expect(() => keyedCursorOption('1.5')).toThrow('--cursor must be a positive integer')
  })

  test('allows a workflow-bound call without reading cursor evidence', () => {
    expect(decideKeyedRunCursorAdmission({ ...base, bindingPresent: true })).toEqual({
      kind: 'allow',
    })
  })

  test('an unkeyed start with a held keyless cursor is allowed and bound to it', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        key: undefined,
        heldCursors: [keylessCursor(17)],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'keyless-17', stepSlug: 'explore' },
    })
  })

  test('an unkeyed start without a keyless cursor is refused with explore and keyed remedies', () => {
    const decision = decideKeyedRunCursorAdmission({ ...base, key: undefined })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow compose explore --project ${PLATFORM_SLUG}`,
    )
    expect(decision.message).toContain('workflow compose plan-task')
    expect(decision.message).toContain('--override-unbound "<reason>" --from-operator')
  })

  test('an unkeyed continue without a keyless cursor is refused', () => {
    expect(decideKeyedRunCursorAdmission({ ...base, key: undefined, turn: 'continue' })).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('refusing unkeyed run turn'),
    })
  })

  test('an unkeyed override is allowed with a warning', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        key: undefined,
        overrideReason: 'Operator emergency.',
        fromOperator: true,
        overridePersonName: 'Dana Example',
      }),
    ).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound run turn overridden by Dana Example: Operator emergency.',
    })
  })

  test('an unkeyed cursor-read failure names the unkeyed remedies without an undefined key', async () => {
    const decision = await checkKeyedRunCursorAdmission(
      { ...base, key: undefined, turn: 'continue' },
      async () => {
        throw new Error('store down')
      },
    )
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain('refusing unkeyed run turn')
    expect(decision.message).toContain('workflow compose explore')
    expect(decision.message).toContain('--arg key=<key>')
    expect(decision.message).not.toContain('key=undefined')
  })

  test('the most recently advanced keyless cursor wins, then the highest number', () => {
    const later = decideKeyedRunCursorAdmission({
      ...base,
      key: undefined,
      heldCursors: [
        keylessCursor(19, '2026-11-20T12:00:00.000Z'),
        keylessCursor(17, '2026-11-20T13:00:00.000Z'),
      ],
    })
    expect(later).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'keyless-17', stepSlug: 'explore' },
    })

    const higher = decideKeyedRunCursorAdmission({
      ...base,
      key: undefined,
      heldCursors: [keylessCursor(17), keylessCursor(19)],
    })
    expect(higher).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'keyless-19', stepSlug: 'explore' },
    })
  })

  test('an explicit cursor must name a held keyless cursor', () => {
    const heldCursors = [keylessCursor(17), keylessCursor(19)]
    expect(
      decideKeyedRunCursorAdmission({ ...base, key: undefined, heldCursors, cursor: 17 }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'keyless-17', stepSlug: 'explore' },
    })
    expect(
      decideKeyedRunCursorAdmission({ ...base, key: undefined, heldCursors, cursor: 18 }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining('naming one of: 17, 19'),
    })
  })

  test('a keyless cursor for another project does not admit an unkeyed start', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        key: undefined,
        heldCursors: [keylessCursor(17, undefined, 'segnavia')],
      }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        `does not hold an open keyless workflow cursor for project ${PLATFORM_SLUG}`,
      ),
    })
  })

  test('a writing job cannot bind to a keyless cursor', () => {
    const decision = decideKeyedRunCursorAdmission({
      ...base,
      key: undefined,
      writesRepo: true,
      heldCursors: [keylessCursor(17)],
    })
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.message).toContain('has no task key and this job writes the repository')
    expect(decision.message).toContain(
      `${PLATFORM_SLUG} workflow step explore --cursor 17 --project ${PLATFORM_SLUG} --arg key=<KEY>`,
    )
    expect(decision.message).toContain('workflow compose plan-task')
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
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
            updatedAt: '2026-11-20T12:00:00.000Z',
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
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
            updatedAt: '2026-11-20T12:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'cursor-record', stepSlug: 'apply-findings' },
    })
  })

  test('a bound root at an unheld cursor binds an explicit selection', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        turn: 'continue',
        bindingPresent: true,
        rootCursorRecordId: 'unheld-cursor-record',
        cursor: 18,
        heldCursors: [
          {
            recordId: 'selected-cursor-record',
            number: 18,
            project: PLATFORM_SLUG,
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
            updatedAt: '2026-11-20T12:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'selected-cursor-record', stepSlug: 'apply-findings' },
    })
  })

  test('a bound root at a held cursor binds a different explicit selection', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        turn: 'continue',
        bindingPresent: true,
        rootCursorRecordId: 'root-cursor-record',
        cursor: 18,
        heldCursors: [
          {
            recordId: 'root-cursor-record',
            number: 17,
            project: PLATFORM_SLUG,
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'implement-fix',
            updatedAt: '2026-11-20T12:00:00.000Z',
          },
          {
            recordId: 'selected-cursor-record',
            number: 18,
            project: PLATFORM_SLUG,
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'apply-findings',
            updatedAt: '2026-11-20T12:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      kind: 'allow',
      binding: { cursorRecordId: 'selected-cursor-record', stepSlug: 'apply-findings' },
    })
  })

  test('a bound root refuses an explicit cursor that is not held', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        turn: 'continue',
        bindingPresent: true,
        rootCursorRecordId: 'root-cursor-record',
        cursor: 18,
        heldCursors: [
          {
            recordId: 'root-cursor-record',
            number: 17,
            project: PLATFORM_SLUG,
            workflowSlug: 'fix-defect',
            workflowKey: 'DEV-2293',
            stepSlug: 'implement-fix',
            updatedAt: '2026-11-20T12:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        'cursor 18 is not an open workflow cursor held by harness session',
      ),
    })
  })

  test('two matching cursors require --cursor and the selected cursor binds', () => {
    const heldCursors = [
      {
        recordId: 'cursor-17',
        number: 17,
        project: PLATFORM_SLUG,
        workflowSlug: 'fix-defect',
        workflowKey: 'DEV-2293',
        stepSlug: 'implement-fix',
        updatedAt: '2026-11-20T12:00:00.000Z',
      },
      {
        recordId: 'cursor-18',
        number: 18,
        project: PLATFORM_SLUG,
        workflowSlug: 'fix-defect',
        workflowKey: 'DEV-2293',
        stepSlug: 'review-lenses',
        updatedAt: '2026-11-20T12:00:00.000Z',
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
          workflowSlug: 'fix-defect',
          workflowKey: 'DEV-2293',
          stepSlug: 'start',
          updatedAt: '2026-11-20T12:00:00.000Z',
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
          workflowSlug: 'explore',
          workflowKey: '',
          stepSlug: 'start',
          updatedAt: '2026-11-20T12:00:00.000Z',
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
        overridePersonName: 'Dana Example',
      }),
    ).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound run turn overridden by Dana Example: Emergency dispatch approved.',
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

  test('an attributed override without a resolved person name records the user', () => {
    expect(
      decideKeyedRunCursorAdmission({
        ...base,
        overrideReason: 'Emergency dispatch approved.',
        fromOperator: true,
      }),
    ).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound run turn overridden by the user: Emergency dispatch approved.',
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
        overridePersonName: 'Dana Example',
      },
      async () => {
        reads += 1
        throw new Error('hosted store unavailable')
      },
    )

    expect(decision).toEqual({
      kind: 'allow-with-override',
      warning: 'unbound run turn overridden by Dana Example: Emergency dispatch approved.',
    })
    expect(reads).toBe(0)
  })
})
