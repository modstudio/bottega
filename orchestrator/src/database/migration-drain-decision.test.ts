import { describe, expect, test } from 'bun:test'
import type { MigrationInFlightRun } from '../run/migration-in-flight-runs.ts'
import { decideMigrationDrain } from './migration-drain-decision.ts'

const journal = [
  { idx: 0, when: 1, tag: '0000_base' },
  { idx: 1, when: 2, tag: '0001_additive', compatibility: 'additive' as const },
  { idx: 2, when: 3, tag: '0002_rebuild' },
]
const running: MigrationInFlightRun = { name: 'run-a', status: 'running', waiting: false }
const asking: MigrationInFlightRun = { name: 'run-b', status: 'asking', waiting: false }

describe('migration drain decision', () => {
  test('applies an empty range', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 3,
        runs: [running],
        canDrain: true,
        waitBoundReached: false,
      }),
    ).toEqual({ action: 'apply-now' })
  })

  test('applies an additive range with runs in flight', () => {
    expect(
      decideMigrationDrain({
        journal: journal.slice(0, 2),
        storeVersion: 1,
        runs: [running],
        canDrain: true,
        waitBoundReached: false,
      }),
    ).toEqual({ action: 'apply-now' })
  })

  test('applies a non-additive range with no runs', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 2,
        runs: [],
        canDrain: true,
        waitBoundReached: false,
      }),
    ).toEqual({ action: 'apply-now' })
  })

  test('drains for a non-additive range with running and asking runs', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 2,
        runs: [running, asking],
        canDrain: true,
        waitBoundReached: false,
      }),
    ).toEqual({ action: 'drain', migration: '0002_rebuild' })
  })

  test('refuses when the wait bound is reached', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 2,
        runs: [running],
        canDrain: true,
        waitBoundReached: true,
      }),
    ).toEqual({ action: 'refuse', reason: 'wait-bound-reached' })
  })

  test('refuses when an incompatible range cannot be drained', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 2,
        runs: [running],
        canDrain: false,
        waitBoundReached: false,
      }),
    ).toEqual({ action: 'refuse', reason: 'drain-impossible' })
  })
})
