import { expect, test } from 'bun:test'
import { MIN_SAMPLE, addRun, recordDuels } from '../test/fixture.ts'
import { statsCommand } from './routing-commands.ts'

test('stats reports Bradley-Terry strengths once a job reaches MIN_SAMPLE duels', () => {
  for (let i = 0; i < MIN_SAMPLE; i++) recordDuels(addRun({ agent: 'codex', job: 'craft' }), [addRun({ agent: 'grok', job: 'craft' })], 's', new Date().toISOString())
  const lines: string[] = []
  statsCommand({ flag: (name) => name === 'job' ? 'craft' : undefined, has: () => false }, { log: (...parts) => lines.push(parts.join(' ')), dur: String })
  expect(lines.join('\n')).toContain(`craft Bradley-Terry strengths (${MIN_SAMPLE} duels)`)
  expect(lines.join('\n')).toContain('codex')
})
