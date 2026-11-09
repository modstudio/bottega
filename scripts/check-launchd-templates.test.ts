import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAINTENANCE_SCHEDULE_PLACEHOLDERS,
  SYSTEMD_UNIT_SUFFIXES,
} from '../orchestrator/src/setup/setup-schedule-policy.ts'
import {
  clockParts,
  installerPlaceholders,
  installerRenderRules,
  launchdFieldTypeViolations,
  missingInstallRules,
  systemdTemplateMappingErrors,
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
  test('a script with no renderer invocation has no install rules', () => {
    expect(installerPlaceholders('sed -e "s#__HOME__#home#g" "$tmpl"')).toEqual(new Set())
  })

  test('an invocation of the shared renderer covers only the pairs it passes', () => {
    const rules = installerPlaceholders(
      `bun --no-env-file "$INSTALL_ROOT/shared/launch-agent-render.ts" "$tmpl" "$target" \\
        "__HOME__" "$HOME" "__INSTALL_ROOT__" "$INSTALL_ROOT"`,
    )
    expect(rules).toEqual(new Set(['__HOME__', '__INSTALL_ROOT__']))
  })
})

describe('missingInstallRules', () => {
  test('a template placeholder fails loudly when the installer does not invoke the renderer', () => {
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

  test('a placeholder passed to the renderer is covered', () => {
    expect(
      missingInstallRules({
        templateName: 'ops/launchd/com.user.example.plist.template',
        templateText: '<integer>__SPARE_START_HOUR__</integer>',
        installerName: 'ops/install.sh',
        installRules: installerPlaceholders(
          'bun --no-env-file shared/launch-agent-render.ts "$tmpl" "$target" "__SPARE_START_HOUR__" "$hour"',
        ),
      }),
    ).toEqual([])
  })
})

describe('the checked-in templates', () => {
  test('every placeholder is rendered by the installer that owns the template', () => {
    const concerns = [
      { directory: 'ops/launchd', installer: 'ops/install.sh' },
      { directory: 'hub/launchd', installer: 'hub/bin/install-launchd.sh' },
      { directory: 'ops/systemd', installer: null },
    ]
    for (const { directory, installer } of concerns) {
      const installRules = installer
        ? installerRenderRules(readFileSync(join(repositoryRoot, installer), 'utf8'))
        : new Set(MAINTENANCE_SCHEDULE_PLACEHOLDERS)
      const names = readdirSync(join(repositoryRoot, directory)).filter((name) =>
        installer
          ? name.endsWith('.plist.template')
          : SYSTEMD_UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix)),
      )
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) {
        const templateText = readFileSync(join(repositoryRoot, directory, name), 'utf8')
        expect(
          missingInstallRules({
            templateName: `${directory}/${name}`,
            templateText,
            installerName: installer ?? 'setup schedule renderer',
            installRules,
          }),
        ).toEqual([])
      }
    }
  })
})

describe('systemdTemplateMappingErrors', () => {
  const mappedNames = [
    'orch-sweep.service',
    'orch-sweep.timer',
    'orch-record-sync.service',
    'orch-record-sync.timer',
    'orch-record-sync.path',
  ]

  test('accepts exactly the mapped units', () => {
    expect(systemdTemplateMappingErrors(mappedNames)).toEqual([])
  })

  test('reports unowned and missing unit files', () => {
    expect(systemdTemplateMappingErrors([...mappedNames.slice(1), 'stray.timer'])).toEqual([
      'ops/systemd/stray.timer: systemd unit is not in SYSTEMD_UNITS',
      'ops/systemd/orch-sweep.service: mapped systemd unit file is missing',
    ])
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

test('a QueueDirectories dictionary is refused', () => {
  expect(
    launchdFieldTypeViolations(
      { QueueDirectories: { '/tmp/record-sync': true } },
      'record-sync.plist',
    ),
  ).toEqual(['record-sync.plist: QueueDirectories must be an array of strings'])
})
