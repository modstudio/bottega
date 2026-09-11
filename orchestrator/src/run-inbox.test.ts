import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { VOIDED_SQL, activeSql, voidedSql } from './evidence-query.ts'
import { MIN_SAMPLE, addRun, recordDuels } from '../test/fixture.ts'
import { statsCommand } from './routing-commands.ts'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

test('inbox voided membership is VOIDED_SQL, not a second copy', () => {
  const inbox = readFileSync(new URL('./run-inbox.ts', import.meta.url), 'utf8')
  expect(inbox).toContain("activeSql('root')")
  expect(inbox).toContain("voidedSql('root')")
  expect(inbox).not.toMatch(/evidence_excluded/)
  expect(normalize(VOIDED_SQL.replaceAll('r.', 'root.'))).toBe(normalize(voidedSql('root')))
  expect(normalize(
    VOIDED_SQL.replaceAll('r.', 'root.').replace('IS NOT NULL', 'IS NULL'),
  )).not.toBe(normalize(voidedSql('root')))
  expect(activeSql('root')).toBe(
    `root.status IN ('running','asking') AND NOT (${voidedSql('root')})`,
  )
})

test('stats reports Bradley-Terry strengths once a job reaches MIN_SAMPLE duels', () => {
  for (let i = 0; i < MIN_SAMPLE; i++) recordDuels(addRun({ agent: 'codex', job: 'craft' }), [addRun({ agent: 'grok', job: 'craft' })], 's', new Date().toISOString())
  const lines: string[] = []; statsCommand({ flag: (name) => name === 'job' ? 'craft' : undefined, has: () => false, values: () => [] }, { log: (...parts) => lines.push(parts.join(' ')), dur: String })
  expect(lines.join('\n')).toContain(`craft Bradley-Terry strengths (${MIN_SAMPLE} duels)`); expect(lines.join('\n')).toContain('codex')
})
