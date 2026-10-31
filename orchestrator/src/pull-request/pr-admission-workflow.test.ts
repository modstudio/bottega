import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REVIEW_READ_VERB } from './pr-admission.ts'

test('workflow steps that mention tier zero name the admitted review-read verb', () => {
  const directory = resolve(import.meta.dir, '../../../.agents/workflow-steps')
  const missing = readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => {
      const body = readFileSync(resolve(directory, name), 'utf8')
      return body.includes('tier zero') && !body.includes(REVIEW_READ_VERB)
    })
  expect(missing).toEqual([])
})
