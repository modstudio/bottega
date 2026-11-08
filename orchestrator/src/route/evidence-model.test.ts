import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { evidenceModel, evidenceModelSql } from './evidence-model.ts'

const openRouter = 'https://openrouter.ai/api/v1'

test('OpenRouter routing variants share evidence while catalog variants remain distinct', () => {
  const cases: [string, string][] = [
    ['x/y:floor', 'x/y'],
    ['x/y:nitro', 'x/y'],
    ['x/y:exacto', 'x/y'],
    ['x/y:nitro:exacto', 'x/y'],
    ['x/y:free', 'x/y:free'],
    ['x/y:batch', 'x/y:batch'],
    ['x/y:thinking', 'x/y:thinking'],
    ['x/y:extended', 'x/y:extended'],
    ['x/y:online', 'x/y:online'],
    ['x/y:free:nitro', 'x/y:free'],
  ]
  for (const [model, expected] of cases) {
    expect(evidenceModel(model, openRouter)).toBe(expected)
  }
})

test('non-OpenRouter model strings are unchanged', () => {
  expect(evidenceModel('x/y:free:nitro', 'https://models.example.test/v1')).toBe('x/y:free:nitro')
})

test('the SQL evidence-model decision matches the pure decision', () => {
  const expression = evidenceModelSql('?1', '?2')
  for (const model of [
    'x/y',
    'x/y:floor',
    'x/y:exacto:nitro',
    'x/y:free:nitro',
    'x/y:floor:floor',
    'x/y:nitro:nitro',
    'x/y:free:floor:floor',
  ]) {
    const row = db().query(`SELECT ${expression} AS model`).get(model, 1) as { model: string }
    expect(row.model).toBe(evidenceModel(model, openRouter))
  }
})
