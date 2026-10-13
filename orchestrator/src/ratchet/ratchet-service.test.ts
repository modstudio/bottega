import { expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeSupport } from './ratchet-service.ts'

test('support files and directories are materialized into the mirror', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-ratchet-support-root-'))
  const mirror = mkdtempSync(join(tmpdir(), 'orch-ratchet-support-mirror-'))
  try {
    mkdirSync(join(root, 'config/plugins'), { recursive: true })
    writeFileSync(join(root, 'config/biome.jsonc'), 'working-tree configuration')
    writeFileSync(join(root, 'config/plugins/rule.ts'), 'working-tree plugin')

    materializeSupport(root, mirror, ['config/biome.jsonc', 'config/plugins'])

    const mirroredFile = join(mirror, 'config/biome.jsonc')
    const mirroredDirectory = join(mirror, 'config/plugins')
    expect(readFileSync(mirroredFile, 'utf8')).toBe('working-tree configuration')
    expect(lstatSync(mirroredFile).isSymbolicLink()).toBe(false)
    expect(lstatSync(mirroredDirectory).isSymbolicLink()).toBe(true)
    expect(realpathSync(mirroredDirectory)).toBe(realpathSync(join(root, 'config/plugins')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(mirror, { recursive: true, force: true })
  }
})
