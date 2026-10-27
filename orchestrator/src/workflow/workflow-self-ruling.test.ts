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
  expect(selfRulingRefusal('auto', [ruling()], 'specification line 4', 3, 'ship-triage')).toBeNull()
  expect(selfRulingRefusal('review', [ruling()], 'canon: delegation', 3, 'ship-triage')).toBeNull()
  expect(selfRulingRefusal('ask', [ruling()], 'specification line 4', 3, 'ship-triage')).toContain(
    'resolved autonomy is ask',
  )
})

test("a person's-ruling floor refuses an agent self-ruling", () => {
  expect(
    selfRulingRefusal('auto', [ruling(true)], 'specification line 4', 3, 'ship-triage'),
  ).toContain('requires a ruling recorded with --from-operator')
})

test("a person's-ruling floor with another alternative names that floor and omits a self-ruling close", () => {
  const artifact: Floor = { ...ruling(), kind: 'recorded-artifact' }
  expect(
    selfRulingRefusal('auto', [artifact, ruling(true)], 'all criteria met', 3, 'ship-triage'),
  ).toBe(
    `self-ruling is refused because this step's ruling floor requires a ruling recorded with --from-operator; close with no ruling using ${flagForFloor('recorded-artifact')}; a person's ruling is needed only when that other evidence does not close the step — use \`${PLATFORM_SLUG} workflow await\` and \`${PLATFORM_SLUG} workflow rule\` instead, with \`--from-operator\` where the operator rules`,
  )
})

test('a step without a ruling floor refuses an agent self-ruling and names the step and its closing flags', () => {
  expect(
    selfRulingRefusal(
      'auto',
      [{ ...ruling(), kind: 'command-exit' }],
      'specification line 4',
      6,
      'record-review',
    ),
  ).toBe(
    `self-ruling is refused because step 6 record-review has no ruling floor; close it with ${flagForFloor('command-exit')}`,
  )
})

test('a self-ruling requires a non-empty basis after authority checks pass', () => {
  expect(selfRulingRefusal('auto', [ruling()], '', 3, 'ship-triage')).toContain('names no basis')
  expect(selfRulingRefusal('auto', [ruling()], ' \n\t ', 3, 'ship-triage')).toContain(
    'names no basis',
  )
  expect(
    selfRulingRefusal('auto', [ruling()], "recorded person's ruling 17", 3, 'ship-triage'),
  ).toBeNull()
})
