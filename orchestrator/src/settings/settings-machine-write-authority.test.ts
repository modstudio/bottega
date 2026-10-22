import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertMachineHomeWriteAuthority,
  isRunningFromRegisteredMainCheckout,
  machineHomesUnderTemporaryDirectory,
} from './settings-machine-write-authority.ts'

test('a standalone secondary clone is not the registered main checkout', () => {
  expect(
    isRunningFromRegisteredMainCheckout('/projects/secondary-clone', '/projects/registered-main'),
  ).toBeFalse()
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

test('a linked invocation without ORCH_MAIN_CHECKOUT names the binary repository root', () => {
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
