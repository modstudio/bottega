import { describe, expect, test } from 'bun:test'
import { decideKeyedRunCursorAdmission } from './keyed-run-cursor-admission.ts'

const base = {
  key: 'DEV-2293',
  project: 'bottega',
  bindingPresent: false,
  callerKind: 'harness' as const,
  sessionId: 'session-fixture',
  heldCursors: [] as Array<{ project: string; workflowKey: string }>,
  overrideReason: undefined,
  fromOperator: false,
}

describe('keyed run cursor admission', () => {
  test.each([
    ['keyless', { key: undefined }],
    ['workflow-bound', { bindingPresent: true }],
    ['operator caller', { callerKind: 'operator' as const }],
    ['worker caller', { callerKind: 'worker' as const }],
    [
      'harness holding the task cursor',
      { heldCursors: [{ project: 'bottega', workflowKey: 'DEV-2293' }] },
    ],
  ])('allows %s', (_name, change) => {
    expect(decideKeyedRunCursorAdmission({ ...base, ...change })).toEqual({ kind: 'allow' })
  })

  test.each([
    ['the key in another project', [{ project: 'segnavia', workflowKey: 'DEV-2293' }]],
    ['only a keyless cursor', [{ project: 'bottega', workflowKey: '' }]],
  ])('refuses a harness holding %s', (_name, heldCursors) => {
    expect(decideKeyedRunCursorAdmission({ ...base, heldCursors })).toEqual({
      kind: 'refuse',
      message: expect.stringContaining(
        'harness session session-fixture does not hold an open workflow cursor for project bottega and task DEV-2293',
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
      message: '--override-unbound requires a non-empty reason',
    })
  })
})
