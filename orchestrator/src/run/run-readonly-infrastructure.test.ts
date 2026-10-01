import { expect, test } from 'bun:test'
import { readonlyInfrastructurePrompt } from './run-readonly-infrastructure.ts'

test('read-only infrastructure describes the provisioned tree without a Docker allowance', () => {
  const prompt = readonlyInfrastructurePrompt({
    readsRepo: true,
    writesRepo: false,
    readonlyCreate: true,
    readonlyNotes: 'Use the prepared fixture.',
    readOnlyBase: '/runs/tree',
    regularNotes: 'Regular notes.',
    generatedNotes: 'Generated readonly_create notes.',
  })

  expect(prompt).toContain('Use the prepared fixture.')
  expect(prompt).not.toContain('Docker is reachable')
})
