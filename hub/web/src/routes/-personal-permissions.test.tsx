import { expect, test } from 'bun:test'
import {
  applySaveSteps,
  matrixRows,
  projectRevisionRefusal,
  saveSteps,
} from '@/routes/-personal-permissions'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'

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

test('a refusal stops the save before any canonical or machine write', async () => {
  const steps = saveSteps(
    { rule: 'Write', layer: 'account', from: 'none', to: 'allow' },
    context,
  ).concat(saveSteps({ rule: 'Write', layer: 'machine', from: 'inherit', to: 'drop' }, context))
  let canonicalCalls = 0
  let machineCalls = 0

  await expect(
    applySaveSteps(
      steps,
      async () => {
        canonicalCalls += 1
      },
      async () => {
        machineCalls += 1
        return { saved: 0, error: null }
      },
      () => undefined,
    ),
  ).rejects.toThrow('Cannot drop Write on this machine: save the account rule first.')
  expect(canonicalCalls).toBe(0)
  expect(machineCalls).toBe(0)
})

test('a project with no stored revision refuses before any write', async () => {
  const steps = saveSteps({ rule: 'Read', layer: 'project', from: 'allow', to: 'deny' }, context)
  const refusal = projectRevisionRefusal(steps, null, 'alpha')
  let canonicalCalls = 0
  let machineCalls = 0

  await expect(
    applySaveSteps(
      refusal ? [refusal, ...steps] : steps,
      async () => {
        canonicalCalls += 1
      },
      async () => {
        machineCalls += 1
        return { saved: 0, error: null }
      },
      () => undefined,
    ),
  ).rejects.toThrow(
    `Cannot save project permissions because alpha has no stored settings revision. Run \`${PLATFORM_SLUG} machine settings render --write --project alpha --yes\` first.`,
  )
  expect(canonicalCalls).toBe(0)
  expect(machineCalls).toBe(0)
})
