import { expect, test } from 'bun:test'
import {
  assertConfigWriteAllowed,
  configGetPresentation,
  configListPresentation,
} from './config.ts'

const row = {
  key: 'autonomy.stage.review',
  environment: 'default',
  scope: 'user' as const,
  value: 'review',
  rowVersion: 3,
  updatedAt: '2026-09-25T12:00:00.000Z',
}

const operatorPid = 400
const operatorInventory = {
  ascertainable: true as const,
  rows: [{ pid: operatorPid, ppid: 1, pgid: operatorPid, command: 'orch config set' }],
}

test('config get --json presents the structured row', () => {
  expect(JSON.parse(configGetPresentation(row, true))).toEqual(row)
})

test('config list --json presents the structured rows', () => {
  expect(JSON.parse(configListPresentation([row], true)[0]!)).toEqual([row])
})

test('config set --json uses the written structured row presentation', () => {
  expect(JSON.parse(configGetPresentation({ ...row, rowVersion: 4 }, true))).toEqual({
    ...row,
    rowVersion: 4,
  })
})

test('an orch worker run cannot write autonomy while an operator process can', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', { ORCH_RUN_ID: '6731' }),
  ).toThrow(
    'refusing autonomy config write from an orch worker run; an operator must run orch config set autonomy.ship-to production',
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, operatorPid, operatorInventory),
  ).not.toThrow()
})

test('a descendant of an orch run executor cannot write autonomy after unsetting its run id', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      { pid: 300, ppid: 200, pgid: 100, command: 'orch config set autonomy.release promote' },
    ],
  }
  expect(() => assertConfigWriteAllowed('autonomy.release', 'promote', {}, 300, inventory)).toThrow(
    'refusing autonomy config write from an orch worker run',
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, 400, inventory),
  ).not.toThrow()
})

test('an explicit invalid ship-to write is refused with the shared allowed list', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'automatic', {}, operatorPid, operatorInventory),
  ).toThrow('expected one of branch, trunk, production')
})
