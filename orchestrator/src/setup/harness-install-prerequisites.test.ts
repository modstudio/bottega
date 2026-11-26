import { expect, test } from 'bun:test'
import {
  harnessInstallPrerequisiteAvailability,
  missingHarnessInstallPrerequisites,
  neededHarnesses,
} from './harness-install-prerequisites.ts'
import { HARNESS_MCP_CATALOGUE } from './setup-mcp.ts'

test('missing harness prerequisites are selected only from known absent facts', () => {
  const route = HARNESS_MCP_CATALOGUE.goose.install.linux
  expect(
    missingHarnessInstallPrerequisites(route, { curl: true, tar: true, bzip2: false }),
  ).toEqual([{ command: 'bzip2', aptPackage: 'bzip2' }])
  expect(missingHarnessInstallPrerequisites(route, {})).toEqual([])
})

test('prerequisite availability probes each command required on the platform', () => {
  const lookedUp: string[] = []
  expect(
    harnessInstallPrerequisiteAvailability('linux', (command) => {
      lookedUp.push(command)
      return command === 'bzip2' ? null : `/bin/${command}`
    }),
  ).toEqual({ curl: true, tar: true, bzip2: false })
  expect(lookedUp).toEqual(['curl', 'tar', 'bzip2'])
})

test('needed harnesses preserve builtin agent-name routing', () => {
  expect(
    neededHarnesses([
      { name: 'codex', harness: 'claude-code', enabled: 1 },
      { name: 'other', harness: 'claude-code', enabled: true },
      { name: 'off', harness: 'goose', enabled: false },
    ]),
  ).toEqual([
    { harness: 'codex', agents: ['codex'] },
    { harness: 'claude', agents: ['other'] },
  ])
})
