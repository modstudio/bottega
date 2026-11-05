import { expect, test } from 'bun:test'
import { matrixRows, saveSteps } from '@/routes/-personal-permissions'

const accountList = (rule: string) => (rule === 'Read' ? ('allow' as const) : undefined)
const context = { project: 'alpha', accountList }

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

test('turning a rule off on this machine drops the account list that holds it', () => {
  expect(saveSteps({ rule: 'Read', layer: 'machine', from: 'ask', to: 'drop' }, context)).toEqual([
    { kind: 'machine', list: 'ask', rule: 'Read', operation: 'remove' },
    { kind: 'machine', list: 'allow', rule: 'Read', operation: 'drop' },
  ])
  expect(
    saveSteps({ rule: 'Read', layer: 'machine', from: 'drop', to: 'inherit' }, context),
  ).toEqual([{ kind: 'machine', list: 'allow', rule: 'Read', operation: 'undrop' }])
})

test('a dropped machine rule reads as off here even when the overlay also adds it', () => {
  const lists = (allow: string[]) => ({ allow, ask: [], deny: [] })
  const rows = matrixRows({
    account: lists(['Read']),
    machine: { additions: lists(['Read']), drop: lists(['Read']) },
  })
  expect(rows).toEqual([{ rule: 'Read', values: { account: 'allow', machine: 'drop' } }])
})
