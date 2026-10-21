import { expect, test } from 'bun:test'
import { formatRunResources, provisioningCommand } from './provisioning-commands.ts'

test('provisioning JSON stays a bare array and resources JSON is opt-in', async () => {
  const output: string[] = []
  const presentation = {
    write: async (value: string) => void output.push(value),
  }
  await provisioningCommand({ json: true, resources: false }, presentation)
  await provisioningCommand({ json: true, resources: true }, presentation)

  expect(JSON.parse(output[0]!)).toBeArray()
  expect(JSON.parse(output[1]!)).toEqual({
    byJob: [],
    byAgent: [],
    byProject: [],
  })
})

test('run resource presentation converts bytes to MiB and labels missing measurements unknown', () => {
  const lines = formatRunResources({
    byJob: [
      {
        job: 'fix',
        runs: 2,
        measuredRuns: 1,
        unmeasuredRuns: 1,
        cpuSeconds: { median: null, p90: null },
        peakRssBytes: { median: 1_572_864, p90: null },
      },
    ],
    byAgent: [],
    byProject: [],
  })

  expect(lines.join('\n')).toContain('CPU seconds median/p90 unknown/unknown')
  expect(lines.join('\n')).toContain('peak RSS MiB median/p90 1.5/unknown')
  expect(lines.join('\n')).toContain('(1 measured, 1 unmeasured)')
  expect(lines).toContain('no runs')
  expect(lines).not.toContain('no run resource samples')
})
