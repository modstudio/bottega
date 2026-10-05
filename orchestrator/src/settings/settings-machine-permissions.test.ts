import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { readMachinePermissions } from '../../../shared/machine-config.ts'
import { editMachineSettingsPermission } from './settings-machine-permissions.ts'

const operatorPid = 400
const inventory = {
  ascertainable: true as const,
  rows: [{ pid: operatorPid, ppid: 1, pgid: operatorPid, command: 'orch settings permission' }],
}

test('machine permission operations edit additions and drops without a hosted row', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-permission-command-'))
  const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
  try {
    const added = editMachineSettingsPermission(
      { operation: 'add', list: 'allow', rule: 'Bash(git status)' },
      env,
      operatorPid,
      inventory,
    )
    expect(added).toMatchObject({ changed: true, counts: { allow: 1, ask: 0, deny: 0 } })
    editMachineSettingsPermission(
      { operation: 'drop', list: 'deny', rule: 'Read(.env)' },
      env,
      operatorPid,
      inventory,
    )
    expect(readMachinePermissions(env)).toEqual({
      additions: { allow: ['Bash(git status)'], ask: [], deny: [] },
      drop: { allow: [], ask: [], deny: ['Read(.env)'] },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('machine permission writes retain the worker refusal', () => {
  expect(() =>
    editMachineSettingsPermission(
      { operation: 'add', list: 'allow', rule: 'Bash(git status)' },
      { ORCH_RUN_ID: 'worker' },
    ),
  ).toThrow('refusing machine permission write from an orch worker run')
})
