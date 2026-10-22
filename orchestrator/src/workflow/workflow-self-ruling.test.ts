import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type Floor, flagForFloor } from './workflow-floor.ts'
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
  expect(selfRulingRefusal('auto', [ruling()], 'specification line 4')).toBeNull()
  expect(selfRulingRefusal('review', [ruling()], 'canon: delegation')).toBeNull()
  expect(selfRulingRefusal('ask', [ruling()], 'specification line 4')).toContain(
    'resolved autonomy is ask',
  )
})

test('an operator-ruling floor refuses an agent self-ruling', () => {
  expect(selfRulingRefusal('auto', [ruling(true)], 'specification line 4')).toContain(
    'requires an operator ruling',
  )
})

test('an operator-ruling floor with another alternative names that floor and omits a self-ruling close', () => {
  const artifact: Floor = { ...ruling(), kind: 'recorded-artifact' }
  expect(selfRulingRefusal('auto', [artifact, ruling(true)], 'all criteria met')).toBe(
    `self-ruling is refused because this step's ruling floor requires an operator ruling; close with no ruling using ${flagForFloor('recorded-artifact')}; an operator ruling is needed only when that other evidence does not close the step — use \`${PLATFORM_SLUG} workflow await\` and \`${PLATFORM_SLUG} workflow rule\` instead, with \`--from-operator\` where the operator rules`,
  )
})

test('a step without a ruling floor refuses an agent self-ruling', () => {
  expect(
    selfRulingRefusal('auto', [{ ...ruling(), kind: 'command-exit' }], 'specification line 4'),
  ).toContain('has no ruling floor; this step is closed with the evidence its floor names')
})

test('a self-ruling requires a non-empty basis after authority checks pass', () => {
  expect(selfRulingRefusal('auto', [ruling()], '')).toContain('names no basis')
  expect(selfRulingRefusal('auto', [ruling()], ' \n\t ')).toContain('names no basis')
  expect(selfRulingRefusal('auto', [ruling()], 'recorded operator ruling 17')).toBeNull()
})
