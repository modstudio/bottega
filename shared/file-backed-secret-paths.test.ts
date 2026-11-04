import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { revokedMachineKeyDirectory } from './config-directory.ts'
import { fileBackedSecretPaths } from './file-backed-secret-paths.ts'
import { replaceRevokedMachineKey, writeMachineKey } from './machine-key-store.ts'
import { generateMachineKeyPair } from './secret-envelope.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('revoked file-backed machine keys remain inside a denied owner-only directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revoked-machine-key-'))
  roots.push(root)
  const environment = {
    BOTTEGA_CONFIG_HOME: root,
    BOTTEGA_KEYSTORE: 'file',
    BOTTEGA_STATE_HOME: root,
  }
  const revokedKeyId = 'revoked-key-id'
  writeMachineKey(await generateMachineKeyPair(), environment)

  replaceRevokedMachineKey(revokedKeyId, await generateMachineKeyPair(), environment)

  const backupDirectory = revokedMachineKeyDirectory(environment)
  const backupPath = join(backupDirectory, revokedKeyId)
  expect(statSync(backupDirectory).mode & 0o777).toBe(0o700)
  expect(statSync(backupPath).mode & 0o777).toBe(0o600)
  expect(
    fileBackedSecretPaths(environment).some((deniedPath) => {
      const descendant = relative(deniedPath, backupPath)
      return descendant !== '' && !descendant.startsWith('..') && !isAbsolute(descendant)
    }),
  ).toBe(true)
})
