import { expect, test } from 'bun:test'
import { failoverSelectionConstraints } from './run-close.ts'

test('failover pins only an explicit transport and excludes agents that cannot honor it', () => {
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 1,
      avoided: ['avoided', 'tried'],
      distinctModels: undefined,
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: 'acp',
    successorTransport: 'acp',
    avoidedAgents: ['avoided', 'tried', 'wrong-transport'],
    distinctModels: undefined,
  })
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 0,
      avoided: ['avoided'],
      distinctModels: undefined,
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: null,
    successorTransport: undefined,
    avoidedAgents: ['avoided', 'tried'],
    distinctModels: undefined,
  })
})

test('failover keeps the distinct model exclusions', () => {
  expect(
    failoverSelectionConstraints({
      transport: null,
      transportExplicit: 0,
      avoided: undefined,
      distinctModels: ['excluded-model'],
      tried: [],
      transportExcluded: [],
    }).distinctModels,
  ).toEqual(['excluded-model'])
})
