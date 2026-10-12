import { expect, test } from 'bun:test'
import type { Floor } from './workflow-floor.ts'
import { selfRulingRefusal } from './workflow-self-ruling.ts'

const ruling = (operatorRuling = false): Floor => ({
  kind: 'ruling',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling,
})

test('only auto and review autonomy permit an agent self-ruling', () => {
  expect(selfRulingRefusal('auto', [ruling()])).toBeNull()
  expect(selfRulingRefusal('review', [ruling()])).toBeNull()
  expect(selfRulingRefusal('ask', [ruling()])).toContain('resolved autonomy is ask')
})

test('an operator-ruling floor refuses an agent self-ruling', () => {
  expect(selfRulingRefusal('auto', [ruling(true)])).toContain('requires an operator ruling')
})

test('a step without a ruling floor refuses an agent self-ruling', () => {
  expect(selfRulingRefusal('auto', [{ ...ruling(), kind: 'command-exit' }])).toContain(
    'has no ruling floor; this step is closed with the evidence its floor names',
  )
})
