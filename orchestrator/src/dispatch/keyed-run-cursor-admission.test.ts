import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  checkKeyedRunCursorAdmission,
  decideKeyedRunCursorAdmission,
} from './keyed-run-cursor-admission.ts'

const base = {
  key: 'DEV-2293',
  project: PLATFORM_SLUG,
  bindingPresent: false,
  harnessSession: 'session-fixture',
  heldCursors: [] as Array<{ project: string; workflowKey: string }>,
  overrideReason: undefined,
  fromOperator: false,
}

describe('keyed run cursor admission', () => {
  test.each([
    ['keyless', { key: undefined }],
    ['workflow-bound', { bindingPresent: true }],
    ['operator caller', { harnessSession: null }],
    ['worker caller', { harnessSession: null }],
    [
      'harness holding the task cursor',
      { heldCursors: [{ project: PLATFORM_SLUG, workflowKey: 'DEV-2293' }] },
    ],
  ])('allows %s', (_name, change) => {
    expect(decideKeyedRunCursorAdmission({ ...base, ...change })).toEqual({ kind: 'allow' })
  })

  test.each([
    ['the key in another project', [{ project: 'segnavia', workflowKey: 'DEV-2293' }]],
    ['only a keyless cursor', [{ project: PLATFORM_SLUG, workflowKey: '' }]],
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
      warning: 'unbound keyed run start overridden by Shmuel Barkin: Emergency dispatch approved.',
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
      warning: 'unbound keyed run start overridden by Shmuel Barkin: Emergency dispatch approved.',
    })
    expect(reads).toBe(0)
  })
})
