import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { ConfigEntrySchema, MachineConfigFileEntrySchema } from '../../../shared/config-contract.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { setConfigEntry } from '../config/config-service.ts'
import {
  assertConfigWriteAllowed,
  configListPresentation,
  configReadPresentation,
  configSetPresentation,
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
  rows: [
    {
      pid: operatorPid,
      ppid: 1,
      pgid: operatorPid,
      command: `${PLATFORM_SLUG} machine config set`,
    },
  ],
}

test('config list --json presents the structured rows', () => {
  expect(JSON.parse(configListPresentation([row], true)[0]!)).toEqual([row])
})

test('config set JSON for hosted and machine homes parses with the hub consumer contracts', async () => {
  const client = {
    putEntry: async () => ({ ...row, rowVersion: 4 }),
  } as unknown as ConfigClient
  const hosted = await setConfigEntry('autonomy.stage.review', 'review', 'user', null, client)
  expect(ConfigEntrySchema.parse(JSON.parse(configSetPresentation(hosted)))).toEqual({
    ...row,
    rowVersion: 4,
  })

  const root = mkdtempSync(join(tmpdir(), 'config-set-presentation-'))
  try {
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    const machine = await setConfigEntry('hub.port', '9000', 'machine', undefined, undefined, env)
    expect(MachineConfigFileEntrySchema.parse(JSON.parse(configSetPresentation(machine)))).toEqual({
      key: 'hub.port',
      value: '9000',
      scope: 'machine',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('config get presents the local autonomy value that outranks a hosted row', () => {
  expect(
    configReadPresentation(
      {
        key: 'autonomy.preset',
        value: 'manual',
        home: 'user',
        source: 'hosted user scope',
        ignoredHostedScopes: [],
        outrankingMachineValue: 'autonomous',
      },
      false,
    ),
  ).toEqual([
    'manual',
    'source: hosted user scope',
    'machine.toml value outranks it at the local user scope: autonomous',
  ])
})

test('an orchestrator worker run cannot write autonomy while an operator process can', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config set autonomy.ship-to production`,
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, operatorPid, operatorInventory),
  ).not.toThrow()
})

test('a descendant of an orchestrator run executor cannot write autonomy after unsetting its run id', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      {
        pid: 300,
        ppid: 200,
        pgid: 100,
        command: `${PLATFORM_SLUG} machine config set autonomy.release promote`,
      },
    ],
  }
  expect(() => assertConfigWriteAllowed('autonomy.release', 'promote', {}, 300, inventory)).toThrow(
    'refusing operator-only machine config write from an orchestrator worker run',
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, 400, inventory),
  ).not.toThrow()
})

test('an orchestrator worker run cannot change machine delegation', () => {
  expect(() =>
    assertConfigWriteAllowed('delegation.implement', 'harness', { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config set --machine delegation.implement harness`,
  )
  expect(() =>
    assertConfigWriteAllowed('delegation.review', undefined, { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config delete --machine delegation.review`,
  )
})

test('an explicit invalid ship-to write is refused with the shared allowed list', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'automatic', {}, operatorPid, operatorInventory),
  ).toThrow('expected one of branch, trunk, production')
})
