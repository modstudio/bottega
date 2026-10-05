import { expect, test } from 'bun:test'
import { registrationProbeRequirements } from './agent-probe.ts'

test('a file-question registration probe always requires the reply file but not native schema', () => {
  expect(registrationProbeRequirements(['file-question'])).toEqual({
    tool: true,
    schema: false,
    mcp: false,
    file: true,
  })
})
