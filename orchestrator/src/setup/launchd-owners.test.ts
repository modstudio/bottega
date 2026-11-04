import { afterEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import {
  installationPlistOwners,
  installedPlistOwners,
  LAUNCHD_TEMPLATE_OWNERS,
} from './launchd-owners.ts'

afterEach(() => registerEmbeddedAssets(null))

test('derives an installer for every current launchd template', () => {
  const root = join(import.meta.dir, '../../..')
  const templates = LAUNCHD_TEMPLATE_OWNERS.flatMap((owner) =>
    readdirSync(join(root, owner.concern, owner.directory))
      .filter((name) => name.endsWith('.plist.template'))
      .map((name) => {
        const path = join(root, owner.concern, owner.directory, name)
        return { path, text: readFileSync(path, 'utf8') }
      }),
  )
  const owners = installedPlistOwners(templates)
  expect(owners).toHaveLength(templates.length)
  expect(
    owners.every(({ command }) =>
      LAUNCHD_TEMPLATE_OWNERS.some((owner) => owner.command === command),
    ),
  ).toBe(true)
})

test('reads installer ownership entirely from the embedded registry', async () => {
  registerEmbeddedAssets({
    assets: {
      'hub/launchd/com.example.embedded.plist.template':
        '<plist><dict><key>Label</key><string>com.example.embedded</string></dict></plist>',
    },
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-11-03T00:00:00.000Z',
      commit: 'abcdef',
    },
  })

  expect(await installationPlistOwners()).toEqual([
    {
      label: 'com.example.embedded',
      command: 'hub/bin/install-launchd.sh',
      templatePath: 'hub/launchd/com.example.embedded.plist.template',
      template:
        '<plist><dict><key>Label</key><string>com.example.embedded</string></dict></plist>',
    },
  ])
})
