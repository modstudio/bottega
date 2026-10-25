import { expect, test } from 'bun:test'
import { measureProvisioningPhase, type ProvisioningPhase } from './provisioning-measurement.ts'

test('records one dependency phase for one execution', () => {
  const recorded: { runId: string; phases: readonly ProvisioningPhase[] }[] = []
  const times = [100, 125]
  let executions = 0

  const result = measureProvisioningPhase(
    'run-id',
    'dependency',
    'declared dependencies',
    () => {
      executions++
      return 'provisioned'
    },
    (runId, phases) => recorded.push({ runId, phases }),
    () => times.shift()!,
  )

  expect(result).toBe('provisioned')
  expect(executions).toBe(1)
  expect(recorded).toEqual([
    {
      runId: 'run-id',
      phases: [{ phase: 'dependency', name: 'declared dependencies', durationMs: 25 }],
    },
  ])
})
