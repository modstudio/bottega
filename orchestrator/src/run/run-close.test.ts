import { expect, test } from 'bun:test'
import { failoverRefusalMessage, failoverSelectionConstraints } from './run-close.ts'

test('a premature-final failover refusal names the manual retry command', () => {
  expect(failoverRefusalMessage('run-id', 'no eligible agent remains', true)).toContain(
    'run retry run-id --agent <name>',
  )
})

test('failover pins only an explicit transport and excludes agents that cannot honor it', () => {
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 1,
      avoided: ['avoided', 'tried'],
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: 'acp',
    successorTransport: 'acp',
    avoidedAgents: ['avoided', 'tried', 'wrong-transport'],
  })
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 0,
      avoided: ['avoided'],
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: null,
    successorTransport: undefined,
    avoidedAgents: ['avoided', 'tried'],
  })
})
