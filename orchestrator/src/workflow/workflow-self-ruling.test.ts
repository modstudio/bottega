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
