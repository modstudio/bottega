import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { testSubstanceReport } from './test-substance-eslint'

test('helper following terminates on mutual recursion', async () => {
  const file = resolve('shared/test-substance/fixtures/recursive.test.ts')
  const report = await testSubstanceReport(
    file,
    `import { test } from 'bun:test'
function first() { second() }
function second() { first() }
test('recursive helpers', () => first())`,
  )
  expect(report.findings).toContainEqual(
    expect.objectContaining({ testName: 'recursive helpers', rule: 'no-assertion' }),
  )
})

test('an unresolvable relative helper is conservatively an assertion', async () => {
  const file = resolve('shared/test-substance/fixtures/unresolved.test.ts')
  const report = await testSubstanceReport(
    file,
    `import { test } from 'bun:test'
import { verifiesResult } from './missing-helper'
test('unresolved helper', () => verifiesResult())`,
  )
  expect(report.findings.filter((finding) => finding.rule === 'no-assertion')).toEqual([])
})
