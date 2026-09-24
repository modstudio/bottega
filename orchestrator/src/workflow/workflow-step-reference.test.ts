import { describe, expect, test } from 'bun:test'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'

describe('workflow step references', () => {
  test('resolves a one-based position', () => {
    expect(
      resolveWorkflowStepReference('2', [{ mode: 'single', steps: ['reproduce', 'implement'] }]),
    ).toBe('implement')
  })

  test('refuses a position outside the valid range', () => {
    expect(() =>
      resolveWorkflowStepReference('3', [{ mode: 'single', steps: ['reproduce', 'implement'] }]),
    ).toThrow('out of range; valid range is 1-2')
  })

  test('resolves without a mode when every long-enough mode agrees', () => {
    expect(
      resolveWorkflowStepReference('2', [
        { mode: 'single', steps: ['reproduce', 'implement'] },
        { mode: 'resume', steps: ['prepare', 'implement', 'verify'] },
        { mode: 'short', steps: ['prepare'] },
      ]),
    ).toBe('implement')
  })

  test('refuses without a mode when modes differ at the position', () => {
    expect(() =>
      resolveWorkflowStepReference('2', [
        { mode: 'single', steps: ['reproduce', 'implement'] },
        { mode: 'resume', steps: ['prepare', 'verify'] },
      ]),
    ).toThrow(
      'workflow step position "2" is ambiguous across modes:\n- mode "single": "implement"\n- mode "resume": "verify"\nfix: pass a mode to select one',
    )
  })
})
