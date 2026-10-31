import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installedPlistOwners } from './launchd-owners.ts'

test('derives an installer for every current launchd template', () => {
  const root = join(import.meta.dir, '../../..')
  const templates = ['hub', 'ops'].flatMap((concern) =>
    readdirSync(join(root, concern, 'launchd'))
      .filter((name) => name.endsWith('.plist.template'))
      .map((name) => {
        const path = join(root, concern, 'launchd', name)
        return { path, text: readFileSync(path, 'utf8') }
      }),
  )
  const owners = installedPlistOwners(templates)
  expect(owners).toHaveLength(templates.length)
  expect(
    owners.every(({ command }) =>
      ['hub/bin/install-launchd.sh', 'ops/install.sh'].includes(command),
    ),
  ).toBe(true)
})
