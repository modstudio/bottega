import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clockParts,
  installerPlaceholders,
  missingInstallRules,
  templatePlaceholders,
} from './check-launchd-templates.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('templatePlaceholders', () => {
  test('names each placeholder once, in the order it appears', () => {
    expect(
      templatePlaceholders('<integer>__B__</integer><key>__A__</key><integer>__B__</integer>'),
    ).toEqual(['__B__', '__A__'])
  })
})

describe('installerPlaceholders', () => {
  test('reads the placeholders an installer has a substitution rule for', () => {
    const rules = installerPlaceholders(
      'sed -e "s#__INSTALL_ROOT__#root#g" -e "s#__HOME__#home#g" "$tmpl" > "$target"',
    )
    expect([...rules].sort()).toEqual(['__HOME__', '__INSTALL_ROOT__'])
  })
})

describe('missingInstallRules', () => {
  test('a template placeholder with no install rule fails the check', () => {
    const errors = missingInstallRules({
      templateName: 'ops/launchd/com.user.example.plist.template',
      templateText: '<dict><key>Hour</key><integer>__NO_RULE__</integer></dict>',
      installerName: 'ops/install.sh',
      installRules: installerPlaceholders('sed -e "s#__INSTALL_ROOT__#root#g" "$tmpl"'),
    })
    expect(errors).toEqual([
      'ops/launchd/com.user.example.plist.template: placeholder __NO_RULE__ has no rule in ops/install.sh',
    ])
  })

  test('a covered placeholder passes', () => {
    expect(
      missingInstallRules({
        templateName: 'ops/launchd/com.user.example.plist.template',
        templateText: '<integer>__SPARE_START_HOUR__</integer>',
        installerName: 'ops/install.sh',
        installRules: installerPlaceholders('sed -e "s#__SPARE_START_HOUR__#hour#g" "$tmpl"'),
      }),
    ).toEqual([])
  })
})

describe('the checked-in templates', () => {
  test('every placeholder is rendered by the installer that owns the template', () => {
    const concerns = [
      { directory: 'ops/launchd', installer: 'ops/install.sh' },
      { directory: 'hub/launchd', installer: 'hub/bin/install-launchd.sh' },
    ]
    for (const { directory, installer } of concerns) {
      const installRules = installerPlaceholders(
        readFileSync(join(repositoryRoot, installer), 'utf8'),
      )
      const names = readdirSync(join(repositoryRoot, directory)).filter((name) =>
        name.endsWith('.plist.template'),
      )
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) {
        const templateText = readFileSync(join(repositoryRoot, directory, name), 'utf8')
        expect(
          missingInstallRules({
            templateName: `${directory}/${name}`,
            templateText,
            installerName: installer,
            installRules,
          }),
        ).toEqual([])
      }
    }
  })
})

describe('clockParts', () => {
  test('reads an HH:MM value', () => {
    expect(clockParts('22:00')).toEqual({ hour: 22, minute: 0 })
    expect(clockParts('05:30')).toEqual({ hour: 5, minute: 30 })
  })

  test('rejects a malformed value', () => {
    expect(clockParts('22')).toBeNull()
    expect(clockParts('5pm')).toBeNull()
    expect(clockParts('24:00')).toBeNull()
    expect(clockParts('22:60')).toBeNull()
  })
})
