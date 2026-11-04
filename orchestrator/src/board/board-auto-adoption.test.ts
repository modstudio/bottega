import { expect, test } from 'bun:test'
import {
  automaticBoardAdoptionSkipped,
  decideAutomaticBoardAdoption,
} from './board-auto-adoption.ts'

test.each([
  [{ adopted: false, hostedConfigured: true, signedIn: true, planTotal: 0 }, { action: 'adopt' }],
  [
    { adopted: false, hostedConfigured: true, signedIn: true, planTotal: 3 },
    { action: 'tell', total: 3 },
  ],
] as const)('automatic board adoption decides from plain facts', (facts, decision) => {
  expect(decideAutomaticBoardAdoption(facts)).toEqual(decision)
})

test.each([
  [{ adopted: true, hostedConfigured: true, signedIn: true }, true],
  [{ adopted: false, hostedConfigured: false, signedIn: true }, true],
  [{ adopted: false, hostedConfigured: true, signedIn: false }, true],
  [{ adopted: false, hostedConfigured: true, signedIn: true }, false],
] as const)('automatic board adoption skip rule is stated once', (facts, skipped) => {
  expect(automaticBoardAdoptionSkipped(facts)).toBe(skipped)
  expect(decideAutomaticBoardAdoption({ ...facts, planTotal: 0 }).action === 'skip').toBe(skipped)
})
