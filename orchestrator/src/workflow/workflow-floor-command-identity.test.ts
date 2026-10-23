import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DIST_MANIFEST, INSTALL_HOME_ENV } from '../../../shared/install-root.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { bottegaVerbArgv } from './workflow-floor.ts'
import { bottegaCommandIdentity } from './workflow-floor-evidence.ts'

test(`command identity accepts only registered ${PLATFORM_SLUG} executable paths`, () => {
  const root = mkdtempSync(join(tmpdir(), `workflow-${PLATFORM_SLUG}-command-`))
  const main = join(root, 'main')
  const installed = join(root, 'installed')
  const executable = (directory: string, targetName: string) => {
    const bin = join(directory, 'bin')
    const target = join(root, targetName)
    mkdirSync(bin, { recursive: true })
    writeFileSync(target, '')
    const path = join(bin, PLATFORM_SLUG)
    symlinkSync(target, path)
    return path
  }
  const mainExecutable = executable(main, 'main-executable')
  const installedExecutable = executable(installed, 'installed-executable')
  const unrelatedExecutable = executable(join(root, 'unrelated'), 'unrelated-executable')
  writeFileSync(
    join(installed, DIST_MANIFEST),
    JSON.stringify({
      name: PLATFORM_NAME,
      version: 'test',
      built: '2026-09-01T00:00:00.000Z',
      commit: 'test',
    }),
  )

  const previousInstallHome = process.env[INSTALL_HOME_ENV]
  process.env[INSTALL_HOME_ENV] = installed
  try {
    const d = testDatabaseFixture((database) => {
      database
        .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
        .run(newRecordId(), PLATFORM_SLUG, main, 'bun', '{}')
    })()
    const accepts = (path: string) =>
      bottegaVerbArgv(
        [path, 'pr', 'create'],
        ['pr', 'create'],
        bottegaCommandIdentity(path, root, d),
      )

    expect(accepts(mainExecutable)).toBeTrue()
    expect(accepts(installedExecutable)).toBeTrue()
    expect(accepts(unrelatedExecutable)).toBeFalse()
  } finally {
    if (previousInstallHome === undefined) delete process.env[INSTALL_HOME_ENV]
    else process.env[INSTALL_HOME_ENV] = previousInstallHome
    rmSync(root, { recursive: true, force: true })
  }
})
