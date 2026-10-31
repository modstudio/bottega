import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { writeMachineNames } from '../../../shared/machine-config.ts'
import { parseArtifactRef } from './workflow-floor.ts'

test('parseArtifactRef surfaces foreign probe and run machine-label refusals', () => {
  const previousConfigRoot = process.env[CONFIG_HOME_ENV]
  const configRoot = mkdtempSync(join(tmpdir(), 'workflow-floor-machine-'))
  process.env[CONFIG_HOME_ENV] = configRoot
  try {
    writeMachineNames({ shortName: 'mine', displayName: 'Mine' })
    expect(parseArtifactRef('probe:other/7')).toEqual({
      error:
        "`other/7` names a row on machine `other`; this command acts only on this machine's (`mine`) rows",
    })
    expect(parseArtifactRef('other/7')).toEqual({
      error:
        "`other/7` names a row on machine `other`; this command acts only on this machine's (`mine`) rows",
    })
  } finally {
    if (previousConfigRoot === undefined) delete process.env[CONFIG_HOME_ENV]
    else process.env[CONFIG_HOME_ENV] = previousConfigRoot
    rmSync(configRoot, { recursive: true, force: true })
  }
})
