import { expect, test } from 'bun:test'
import { matrixRows, saveSteps } from '@/routes/-personal-permissions'

const accountList = (rule: string) => (rule === 'Read' ? ('allow' as const) : undefined)
const machineDropList = (rule: string) => (rule === 'Read' ? ('deny' as const) : undefined)
const context = { project: 'alpha', accountList, machineDropList }

test('moving a rule between lists removes it before adding it', () => {
  expect(saveSteps({ rule: 'Read', layer: 'project', from: 'allow', to: 'deny' }, context)).toEqual(
    [
      {
        kind: 'canonical',
        target: { project: 'alpha' },
        list: 'allow',
        rule: 'Read',
        operation: 'remove',
      },
      {
        kind: 'canonical',
        target: { project: 'alpha' },
        list: 'deny',
        rule: 'Read',
        operation: 'add',
      },
    ],
  )
})

test('drop uses the account list while undrop uses the saved machine drop list', () => {
  expect(saveSteps({ rule: 'Read', layer: 'machine', from: 'ask', to: 'drop' }, context)).toEqual([
    { kind: 'machine', list: 'ask', rule: 'Read', operation: 'remove' },
    { kind: 'machine', list: 'allow', rule: 'Read', operation: 'drop' },
  ])
  expect(
    saveSteps({ rule: 'Read', layer: 'machine', from: 'drop', to: 'inherit' }, context),
  ).toEqual([{ kind: 'machine', list: 'deny', rule: 'Read', operation: 'undrop' }])
})

test('a machine addition applies even when the overlay also drops the rule', () => {
  const lists = (allow: string[]) => ({ allow, ask: [], deny: [] })
  const rows = matrixRows({
    account: lists(['Read']),
    machine: { additions: lists(['Read']), drop: lists(['Read']) },
  })
  expect(rows).toEqual([{ rule: 'Read', values: { account: 'allow', machine: 'allow' } }])
})

test('dropping a rule refuses until its account rule has been saved', () => {
  expect(
    saveSteps(
      { rule: 'Write', layer: 'machine', from: 'inherit', to: 'drop' },
      { project: 'alpha', accountList, machineDropList },
    ),
  ).toEqual([
    {
      kind: 'refusal',
      message: 'Cannot drop Write on this machine: save the account rule first.',
    },
  ])
})
