import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { VOIDED_SQL, activeSql, voidedSql } from './evidence-query.ts'

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
