import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertMachineHomeWriteAuthority,
  decideMachineHomeWriteAuthority,
  machineHomesUnderTemporaryDirectory,
} from './settings-machine-write-authority.ts'

test('write authority allows the main checkout and temporary homes only', () => {
  expect(
    decideMachineHomeWriteAuthority({
      runningFromRegisteredMainCheckout: true,
      targetHomesUnderTemporaryDirectory: false,
    }),
  ).toEqual({ action: 'allow' })
  expect(
    decideMachineHomeWriteAuthority({
      runningFromRegisteredMainCheckout: false,
      targetHomesUnderTemporaryDirectory: true,
    }),
  ).toEqual({ action: 'allow' })
  expect(
    decideMachineHomeWriteAuthority({
      runningFromRegisteredMainCheckout: false,
      targetHomesUnderTemporaryDirectory: false,
    }),
  ).toEqual({ action: 'refuse-not-registered-main' })
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
      registeredMainCheckout: '/projects/registered-main',
      runningInstallationRoot: '/projects/secondary-clone',
      binaryRepositoryRoot: '/projects/secondary-clone',
    }),
  ).toThrow('real harness homes may only be written from the registered main checkout')
})

test('a linked invocation without BOTTEGA_MAIN_CHECKOUT names the binary repository root', () => {
  expect(() =>
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      registeredMainCheckout: null,
      runningInstallationRoot: '/projects/main/.claude/worktrees/fixture',
      binaryRepositoryRoot: '/projects/main',
    }),
  ).toThrow(`cleared by: run \`/projects/main/bin/${PLATFORM_SLUG} machine settings apply\``)
  try {
    assertMachineHomeWriteAuthority({
      command: 'machine settings apply',
      targetHomes: ['/operator/.claude'],
      runningFromRegisteredMainCheckout: false,
      registeredMainCheckout: null,
      runningInstallationRoot: '/projects/main/.claude/worktrees/fixture',
      binaryRepositoryRoot: '/projects/main',
    })
  } catch (error) {
    expect(String(error)).not.toContain('MAIN_CHECKOUT')
  }
})
