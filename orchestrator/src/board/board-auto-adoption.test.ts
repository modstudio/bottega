import { expect, test } from 'bun:test'
import { decideAutomaticBoardAdoption } from './board-auto-adoption.ts'

test.each([
  [{ adopted: true, hostedConfigured: true, signedIn: true, planTotal: 0 }, { action: 'skip' }],
  [{ adopted: false, hostedConfigured: false, signedIn: true, planTotal: 0 }, { action: 'skip' }],
  [{ adopted: false, hostedConfigured: true, signedIn: false, planTotal: 0 }, { action: 'skip' }],
  [{ adopted: false, hostedConfigured: true, signedIn: true, planTotal: 0 }, { action: 'adopt' }],
  [
    { adopted: false, hostedConfigured: true, signedIn: true, planTotal: 3 },
    { action: 'tell', total: 3 },
  ],
] as const)('automatic board adoption decides from plain facts', (facts, decision) => {
  expect(decideAutomaticBoardAdoption(facts)).toEqual(decision)
})
