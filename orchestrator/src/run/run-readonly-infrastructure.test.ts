import { describe, expect, test } from 'bun:test'
import { readonlyInfrastructurePrompt } from './run-readonly-infrastructure.ts'

const dockerSentence =
  "Docker is reachable from this tree so that the project's gate can run; run the gate and no other Docker verb."

describe('read-only infrastructure prompt', () => {
  for (const readonlyNotes of [undefined, 'Use the prepared fixture.']) {
    const branch = readonlyNotes === undefined ? 'without readonly_notes' : 'with readonly_notes'

    test(`flagged readonly_create appends the gate-only Docker sentence ${branch}`, () => {
      const prompt = readonlyInfrastructurePrompt({
        readsRepo: true,
        writesRepo: false,
        readonlyCreate: true,
        readonlyNotes,
        readonlyDocker: true,
        readOnlyBase: '/runs/tree',
        regularNotes: 'Regular notes.',
        generatedNotes: 'Generated readonly_create notes.',
      })

      expect(prompt).toContain(dockerSentence)
      expect(prompt).toContain(
        readonlyNotes === undefined ? 'Generated readonly_create notes.' : readonlyNotes,
      )
    })

    test(`unflagged readonly_create omits the Docker sentence ${branch}`, () => {
      const prompt = readonlyInfrastructurePrompt({
        readsRepo: true,
        writesRepo: false,
        readonlyCreate: true,
        readonlyNotes,
        readonlyDocker: false,
        readOnlyBase: '/runs/tree',
        regularNotes: 'Regular notes.',
        generatedNotes: 'Generated readonly_create notes.',
      })

      expect(prompt).not.toContain(dockerSentence)
    })
  }
})
