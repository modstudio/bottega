import { expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { AGENTS } from './agent-registry.ts'
import { db } from './db.ts'
import { recordDuels } from './duel.ts'
import { MIN_SAMPLE } from './route.ts'
import { pickCommand, statsCommand } from './routing-commands.ts'

const preview = (avoid: string[] = [], distinctModels: string[] = []) => {
  const lines: string[] = []
  pickCommand(
    {
      jobName: 'review-lens',
      stack: null,
      avoid,
      distinctModels,
      lens: undefined,
      selectedAgent: undefined,
    },
    { has: () => false, flag: () => undefined },
    { log: (...parts) => lines.push(parts.join(' ')), agents: AGENTS },
  )
  return lines.join('\n')
}

test('stats reports Bradley-Terry strengths once a job reaches MIN_SAMPLE duels', () => {
  for (let i = 0; i < MIN_SAMPLE; i++)
    recordDuels(
      addRun({ agent: 'codex', job: 'craft' }),
      [addRun({ agent: 'grok', job: 'craft' })],
      's',
      new Date().toISOString(),
    )
  const lines: string[] = []
  statsCommand(
    { flag: (name) => (name === 'job' ? 'craft' : undefined), has: () => false },
    { log: (...parts) => lines.push(parts.join(' ')), dur: String },
  )
  expect(lines.join('\n')).toContain(`craft Bradley-Terry strengths (${MIN_SAMPLE} duels)`)
  expect(lines.join('\n')).toContain('codex')
})

test('pick previews the same fan-out exclusions do uses', () => {
  const prior = addRun({ agent: 'grok', job: 'review-lens' })
  db().query('UPDATE run SET model=? WHERE id=?').run(AGENTS.grok!.model, prior)
  expect(preview(['grok'])).toContain('review-lens -> codex')
  expect(preview([], [AGENTS.grok!.model!])).toContain('review-lens -> codex')
})

test('pick shares do validation for fan-out exclusions', () => {
  const shown = preview(['grok'])
  expect(shown).toContain('review-lens -> codex')
  expect(shown).not.toContain('review-lens -> grok')
})

test('pick refuses an unmet constraint instead of silently routing', () => {
  expect(() => preview(['grok', 'codex'])).toThrow('routing constraints leave no eligible agent')
})
