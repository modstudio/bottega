import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertMachineHomeWriteAuthority,
  decideMachineHomeWriteAuthority,
  machineHomesUnderTemporaryDirectory,
} from './settings-machine-write-authority.ts'

const authorityFacts = {
  runningFromRegisteredMainCheckout: false,
  runningCopyIsDistribution: false,
  registeredMainCheckoutExists: true,
  targetHomesUnderTemporaryDirectory: false,
}

test('write authority allows the registered main checkout', () => {
  expect(
    decideMachineHomeWriteAuthority({
      ...authorityFacts,
      runningFromRegisteredMainCheckout: true,
    }),
  ).toEqual({ action: 'allow' })
})

test('write authority allows a distribution when no registered main checkout exists', () => {
  expect(
    decideMachineHomeWriteAuthority({
      ...authorityFacts,
      runningCopyIsDistribution: true,
      registeredMainCheckoutExists: false,
    }),
  ).toEqual({ action: 'allow' })
})

test('write authority refuses a distribution when a registered main checkout exists', () => {
  expect(
    decideMachineHomeWriteAuthority({
      ...authorityFacts,
      runningCopyIsDistribution: true,
    }),
  ).toEqual({ action: 'refuse-not-registered-main' })
})

test('write authority refuses a secondary checkout', () => {
  expect(decideMachineHomeWriteAuthority(authorityFacts)).toEqual({
    action: 'refuse-not-registered-main',
  })
})

test('write authority keeps the temporary-directory exemption', () => {
  expect(
    decideMachineHomeWriteAuthority({
      ...authorityFacts,
      targetHomesUnderTemporaryDirectory: true,
    }),
  ).toEqual({ action: 'allow' })
})

test('temporary authority requires every target home to be under the OS temporary directory', () => {
  expect(
    machineHomesUnderTemporaryDirectory([
      join(tmpdir(), 'fixture', '.claude'),
      join(tmpdir(), 'fixture', '.codex'),
    ]),
  ).toBeTrue()
  expect(
    machineHomesUnderTemporaryDirectory([join(tmpdir(), 'fixture', '.claude'), '/operator/.codex']),
  ).toBeFalse()
})

test('a temporary root at or above the user home is never an exception', () => {
  expect(
    machineHomesUnderTemporaryDirectory(['/operator/.claude'], '/operator', '/operator'),
  ).toBeFalse()
  expect(machineHomesUnderTemporaryDirectory(['/operator/.claude'], '/', '/operator')).toBeFalse()
})

test('a temporary root below the user home remains an exception', () => {
  expect(
    machineHomesUnderTemporaryDirectory(
      ['/operator/tmp/fixture/.claude'],
      '/operator/tmp',
      '/operator',
    ),
  ).toBeTrue()
})

test('a standalone secondary clone is refused', () => {
  expect(() =>
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      runningCopyIsDistribution: false,
      registeredMainCheckout: '/projects/registered-main',
      runningInstallationRoot: '/projects/secondary-clone',
      binaryRepositoryRoot: '/projects/secondary-clone',
    }),
  ).toThrow("real harness homes may only be written from this machine's installed copy")
})

test('a distribution on a development machine names the registered main executable', () => {
  expect(() =>
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      runningCopyIsDistribution: true,
      registeredMainCheckout: '/projects/registered-main',
      runningInstallationRoot: '/opt/bottega',
      binaryRepositoryRoot: null,
    }),
  ).toThrow(
    `cleared by: run \`/projects/registered-main/bin/${PLATFORM_SLUG} machine settings apply\``,
  )
})

test('an unregistered linked worktree names registration and rerun from its main checkout', () => {
  expect(() =>
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      runningCopyIsDistribution: false,
      registeredMainCheckout: null,
      runningInstallationRoot: '/projects/main/.claude/worktrees/fixture',
      binaryRepositoryRoot: '/projects/main',
    }),
  ).toThrow(
    `cleared by: run \`/projects/main/bin/${PLATFORM_SLUG} project add /projects/main\`, then \`/projects/main/bin/${PLATFORM_SLUG} machine settings apply\``,
  )
})

test('an unregistered main checkout names registration and rerun from itself', () => {
  expect(() =>
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      runningCopyIsDistribution: false,
      registeredMainCheckout: null,
      runningInstallationRoot: '/projects/main',
      binaryRepositoryRoot: null,
    }),
  ).toThrow(
    `cleared by: run \`/projects/main/bin/${PLATFORM_SLUG} project add /projects/main\`, then \`/projects/main/bin/${PLATFORM_SLUG} machine settings apply\``,
  )
})
