import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  environmentFileDecision,
  environmentFilesDecision,
  environmentMigrationMessage,
  environmentSettingsDecision,
  installedPlistOwners,
  migrateOperatorEnvironment,
  restoreOperatorEnvironmentBackup,
  staleInstalledPlistEnvironmentNames,
} from './setup-environment.ts'

const temporary: string[] = []
const adapters = () => ({
  migrateSecrets: async () => [],
  migrateRegister: async () => [],
  migrateSettings: async () => [],
  rerenderSettings: async () => false,
  preflight: async () => {},
})
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('renames an old assignment while preserving its value byte for byte', () => {
  const value = String.raw`"a value with $HOME = and \\ escapes" # retained`
  const input = `export ORCH_RECORD_URL=${value}\r\n`
  expect(environmentFileDecision(input)).toEqual({
    kind: 'replace',
    text: `export BOTTEGA_RECORD_URL=${value}\r\n`,
    names: ['BOTTEGA_RECORD_URL'],
  })
})

test('leaves a new assignment unchanged', () => {
  expect(environmentFileDecision('BOTTEGA_RECORD_URL=value\n')).toEqual({ kind: 'unchanged' })
})

test('refuses a file that holds both old and new names and identifies both lines', () => {
  expect(environmentFileDecision('ORCH_RECORD_URL=old\nBOTTEGA_RECORD_URL=new\n')).toEqual({
    kind: 'refuse',
    oldName: 'ORCH_RECORD_URL',
    oldLine: 1,
    newName: 'BOTTEGA_RECORD_URL',
    newLine: 2,
  })
})

test('refuses an inventoried old name left in comments or quoted text', () => {
  expect(environmentFileDecision('# ORCH_RECORD_URL=comment\n')).toEqual({
    kind: 'refuse-residue',
    name: 'ORCH_RECORD_URL',
    line: 1,
  })
  expect(environmentFileDecision('"ORCH_RECORD_URL=quoted"\n')).toEqual({
    kind: 'refuse-residue',
    name: 'ORCH_RECORD_URL',
    line: 1,
  })
})

test.each([
  ['readonly ORCH_RECORD_URL=value\n', 1],
  ['OTHER=x ORCH_RECORD_URL=value\n', 1],
  ['echo $ORCH_RECORD_URL\n', 1],
  [`echo \${ORCH_RECORD_URL}\n`, 1],
] as const)('refuses unsupported old-name residue in %s', (text, line) => {
  expect(environmentFileDecision(text)).toEqual({
    kind: 'refuse-residue',
    name: 'ORCH_RECORD_URL',
    line,
  })
})

test('renames an indented assignment', () => {
  expect(environmentFileDecision('  export ORCH_RECORD_URL=value\n')).toEqual({
    kind: 'replace',
    text: '  export BOTTEGA_RECORD_URL=value\n',
    names: ['BOTTEGA_RECORD_URL'],
  })
})

test.each([
  ['ORCH_DB', 'BOTTEGA_ORCHESTRATOR_DB'],
  ['ORCH_DB_APP', 'BOTTEGA_ORCHESTRATOR_DB_APP'],
  ['HUB_DB', 'BOTTEGA_HUB_DB'],
  ['HUB_PORT', 'BOTTEGA_HUB_PORT'],
  ['ORCH_RECORD_API_URL', 'BOTTEGA_RECORD_API_URL'],
  ['HUB_RECORD_API_URL', 'BOTTEGA_RECORD_API_URL'],
] as const)('maps the inventoried special case %s exactly', (oldName, newName) => {
  expect(environmentFileDecision(`${oldName}=value\n`)).toEqual({
    kind: 'replace',
    text: `${newName}=value\n`,
    names: [newName],
  })
})

test.each([
  ['ORCH_PORTS_WEB', 'BOTTEGA_PORTS_WEB'],
  ['ORCH_DB_REPLICA', 'BOTTEGA_ORCHESTRATOR_DB_REPLICA'],
  ['ORCH_ALLOC_CACHE', 'BOTTEGA_ALLOC_CACHE'],
] as const)('maps the dynamic family member %s', (oldName, newName) => {
  expect(environmentFileDecision(`${oldName}=value\n`)).toEqual({
    kind: 'replace',
    text: `${newName}=value\n`,
    names: [newName],
  })
})

test('finds a later residue when the first legacy-looking occurrence is embedded', () => {
  expect(environmentFileDecision('echo XHUB_DB $ORCH_DB_REPLICA\n')).toEqual({
    kind: 'refuse-residue',
    name: 'ORCH_DB_REPLICA',
    line: 1,
  })
})

test('leaves a non-inventoried legacy-looking name untouched', () => {
  expect(environmentFileDecision('HUB_FOO=x\n')).toEqual({ kind: 'unchanged' })
})

test('refuses two old names that converge on one new name', () => {
  expect(environmentFileDecision('ORCH_RECORD_API_URL=a\nHUB_RECORD_API_URL=b\n')).toEqual({
    kind: 'refuse',
    oldName: 'ORCH_RECORD_API_URL',
    oldLine: 1,
    newName: 'BOTTEGA_RECORD_API_URL',
    newLine: 2,
  })
})

test('refuses a mapped-name conflict across files before producing writes', () => {
  expect(
    environmentFilesDecision([
      { path: '/home/.zshrc', text: 'ORCH_RECORD_API_URL=a\n' },
      { path: '/home/.profile', text: 'BOTTEGA_RECORD_API_URL=b\n' },
    ]),
  ).toEqual({
    kind: 'refuse',
    first: { name: 'ORCH_RECORD_API_URL', line: 1, start: 0, end: 19, path: '/home/.zshrc' },
    second: {
      name: 'BOTTEGA_RECORD_API_URL',
      line: 1,
      start: 0,
      end: 22,
      path: '/home/.profile',
    },
    newName: 'BOTTEGA_RECORD_API_URL',
  })
})

test('refuses two old names that converge across separate files', () => {
  const decision = environmentFilesDecision([
    { path: '/home/.zshrc', text: 'ORCH_RECORD_API_URL=a\n' },
    { path: '/home/.profile', text: 'HUB_RECORD_API_URL=b\n' },
  ])
  expect(decision).toEqual({
    kind: 'refuse',
    first: { name: 'ORCH_RECORD_API_URL', line: 1, start: 0, end: 19, path: '/home/.zshrc' },
    second: { name: 'HUB_RECORD_API_URL', line: 1, start: 0, end: 18, path: '/home/.profile' },
    newName: 'BOTTEGA_RECORD_API_URL',
  })
})

test('renames repeated occurrences of the same old names across files', () => {
  expect(
    environmentFilesDecision([
      {
        path: '/home/.zshenv',
        text: 'export ORCH_RECORD_API_URL=a\nexport HUB_HOSTED_URL=b\n',
      },
      {
        path: '/home/.claude/.env',
        text: 'ORCH_RECORD_API_URL=a\nHUB_HOSTED_URL=b\n',
      },
    ]),
  ).toEqual({
    kind: 'replace',
    files: [
      {
        path: '/home/.zshenv',
        decision: {
          kind: 'replace',
          text: 'export BOTTEGA_RECORD_API_URL=a\nexport BOTTEGA_HOSTED_URL=b\n',
          names: ['BOTTEGA_HOSTED_URL', 'BOTTEGA_RECORD_API_URL'],
        },
      },
      {
        path: '/home/.claude/.env',
        decision: {
          kind: 'replace',
          text: 'BOTTEGA_RECORD_API_URL=a\nBOTTEGA_HOSTED_URL=b\n',
          names: ['BOTTEGA_HOSTED_URL', 'BOTTEGA_RECORD_API_URL'],
        },
      },
    ],
  })
})

test('renames repeated occurrences of one old name in one file', () => {
  expect(
    environmentFileDecision('ORCH_RECORD_API_URL=first\nORCH_RECORD_API_URL=second\n'),
  ).toEqual({
    kind: 'replace',
    text: 'BOTTEGA_RECORD_API_URL=first\nBOTTEGA_RECORD_API_URL=second\n',
    names: ['BOTTEGA_RECORD_API_URL'],
  })
})

test('rewrites inventoried and dynamic allocation names in nested register settings on word boundaries', () => {
  expect(
    environmentSettingsDecision({
      notes: 'use $ORCH_PORTS_WEB with ORCH_DB; leave XHUB_DB and HUB_FOO alone',
      worktree: { serve: ['ORCH_PORTS_API', 'ORCH_PORTS_HUB'] },
    }),
  ).toEqual({
    value: {
      notes: 'use $BOTTEGA_PORTS_WEB with BOTTEGA_ORCHESTRATOR_DB; leave XHUB_DB and HUB_FOO alone',
      worktree: { serve: ['BOTTEGA_PORTS_API', 'BOTTEGA_PORTS_HUB'] },
    },
    names: [
      'BOTTEGA_ORCHESTRATOR_DB',
      'BOTTEGA_PORTS_API',
      'BOTTEGA_PORTS_HUB',
      'BOTTEGA_PORTS_WEB',
    ],
  })
})

test('detects an old environment name in an installed plist without matching prose', () => {
  expect(
    staleInstalledPlistEnvironmentNames(
      '<key>EnvironmentVariables</key><dict><key>HUB_HOSTED_URL</key></dict>',
    ),
  ).toEqual(['HUB_HOSTED_URL'])
  expect(staleInstalledPlistEnvironmentNames('HUB_FOO is owned elsewhere')).toEqual([])
})

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

test('the file adapter preserves restrictive modes on the replacement and backup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-'))
  temporary.push(home)
  const path = join(home, '.zshenv')
  writeFileSync(path, 'ORCH_RECORD_URL=secret\n')
  chmodSync(path, 0o600)

  const report = await migrateOperatorEnvironment(home, adapters())

  expect(readFileSync(path, 'utf8')).toBe('BOTTEGA_RECORD_URL=secret\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(report.files[0]!.backup).mode & 0o777).toBe(0o600)
})

test('migrates a symlink target without replacing the symlink and keeps an existing backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-environment-link-'))
  temporary.push(root)
  const home = join(root, 'home')
  const target = join(root, 'dotfiles-zshenv')
  mkdirSync(home, { recursive: true })
  writeFileSync(target, 'ORCH_RECORD_URL=first\n')
  symlinkSync(target, join(home, '.zshenv'))
  writeFileSync(`${target}.${PLATFORM_SLUG}-env-backup`, 'earliest\n')

  const report = await migrateOperatorEnvironment(home, adapters())

  expect(readFileSync(target, 'utf8')).toBe('BOTTEGA_RECORD_URL=first\n')
  expect(readFileSync(`${target}.${PLATFORM_SLUG}-env-backup`, 'utf8')).toBe('earliest\n')
  expect(report.files[0]?.path).toBe(realpathSync(target))
  expect(report.files[0]?.backup).toContain('(kept existing)')
  expect(lstatSync(join(home, '.zshenv')).isSymbolicLink()).toBe(true)
})

test('a preflight refusal leaves files and beside backups untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-refusal-'))
  temporary.push(home)
  const path = join(home, '.zshenv')
  writeFileSync(path, 'ORCH_RECORD_URL=secret\n')
  const refusing = {
    ...adapters(),
    preflight: async () => Promise.reject(new Error('not writable')),
  }

  await expect(migrateOperatorEnvironment(home, refusing)).rejects.toThrow('not writable')
  expect(readFileSync(path, 'utf8')).toBe('ORCH_RECORD_URL=secret\n')
  expect(() => statSync(`${path}.${PLATFORM_SLUG}-env-backup`)).toThrow()
})

test('a stale installed plist is a follow-up after environment files migrate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-plist-'))
  temporary.push(home)
  writeFileSync(join(home, '.zshenv'), 'HUB_HOSTED_URL=https://example.test\n')
  const root = join(import.meta.dir, '../../..')
  const template = ['hub', 'ops']
    .flatMap((concern) =>
      readdirSync(join(root, concern, 'launchd')).map((name) => ({ concern, name })),
    )
    .find(({ name }) => name.endsWith('.plist.template'))!
  const text = readFileSync(join(root, template.concern, 'launchd', template.name), 'utf8')
  const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1]!
  const agents = join(home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(
    join(agents, `${label}.plist`),
    '<key>EnvironmentVariables</key><dict><key>HUB_HOSTED_URL</key></dict>',
  )

  const report = await migrateOperatorEnvironment(home, adapters())
  expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('BOTTEGA_HOSTED_URL')
  expect(report.followUps).toEqual([
    expect.objectContaining({ path: join(agents, `${label}.plist`) }),
  ])
  expect(report.restoreCommand).toContain('machine setup restore')
})

test('record-less reporting says there is nothing to migrate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-local-'))
  temporary.push(home)
  const report = await migrateOperatorEnvironment(home, {
    ...adapters(),
    notes: () => ['no hosted record: nothing to migrate'],
  })
  expect(environmentMigrationMessage(report)).toContain('no hosted record: nothing to migrate')
})

test('an unreachable configured record refuses resumably after file migration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-unreachable-'))
  temporary.push(home)
  const path = join(home, '.zshenv')
  writeFileSync(path, 'ORCH_RECORD_URL=secret\n')
  await expect(
    migrateOperatorEnvironment(home, {
      ...adapters(),
      migrateSecrets: async () => Promise.reject(new Error('record unreachable')),
    }),
  ).rejects.toThrow(new RegExp(`record unreachable.*re-run ${PLATFORM_SLUG} machine setup apply`))
  expect(readFileSync(path, 'utf8')).toBe('BOTTEGA_RECORD_URL=secret\n')
})

test('apply then restore recovers every rewritten home file byte for byte', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-restore-'))
  temporary.push(home)
  const claude = join(home, '.claude')
  mkdirSync(claude, { recursive: true })
  const environment = join(home, '.zshenv')
  const settings = join(claude, 'settings.json')
  writeFileSync(environment, 'ORCH_RECORD_URL=secret\n')
  writeFileSync(settings, '{"hooks":{"old":true}}\n')
  const beforeEnvironment = readFileSync(environment)
  const beforeSettings = readFileSync(settings)
  const report = await migrateOperatorEnvironment(home, {
    ...adapters(),
    rerenderSettings: async () => {
      writeFileSync(settings, '{"hooks":{"new":true}}\n')
      return true
    },
  })

  await restoreOperatorEnvironmentBackup(report.backupDirectory!, {
    restoreRegister: async () => {},
    restoreSecrets: async () => {},
    restoreSettings: async () => {},
  })
  expect(readFileSync(environment)).toEqual(beforeEnvironment)
  expect(readFileSync(settings)).toEqual(beforeSettings)
  expect(() => statSync(`${environment}.${PLATFORM_SLUG}-env-backup`)).toThrow()
})

test('restore reverses the sealed-secret and stored-settings names recorded by migration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-services-'))
  temporary.push(home)
  const secrets = new Set(['ORCH_RECORD_URL'])
  const settings = new Set(['ORCH_RECORD_MIGRATE_URL'])
  const secretMigration = {
    oldName: 'ORCH_RECORD_URL',
    newName: 'BOTTEGA_RECORD_URL',
    scope: 'user' as const,
  }
  const settingMigration = {
    oldName: 'ORCH_RECORD_MIGRATE_URL',
    newName: 'BOTTEGA_RECORD_MIGRATE_URL',
  }
  const report = await migrateOperatorEnvironment(home, {
    ...adapters(),
    migrateSecrets: async () => {
      secrets.delete(secretMigration.oldName)
      secrets.add(secretMigration.newName)
      return [secretMigration]
    },
    migrateSettings: async () => {
      settings.delete(settingMigration.oldName)
      settings.add(settingMigration.newName)
      return [settingMigration]
    },
  })

  await restoreOperatorEnvironmentBackup(report.backupDirectory!, {
    restoreRegister: async () => {},
    restoreSecrets: async (migrations) => {
      expect(migrations).toEqual([secretMigration])
      secrets.delete(secretMigration.newName)
      secrets.add(secretMigration.oldName)
    },
    restoreSettings: async (migrations) => {
      expect(migrations).toEqual([settingMigration])
      settings.delete(settingMigration.newName)
      settings.add(settingMigration.oldName)
    },
  })

  expect([...secrets]).toEqual(['ORCH_RECORD_URL'])
  expect([...settings]).toEqual(['ORCH_RECORD_MIGRATE_URL'])
})

test('a follow-up-only run retains no backup and offers no restore', async () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-follow-up-only-'))
  temporary.push(home)
  const root = join(import.meta.dir, '../../..')
  const template = ['hub', 'ops']
    .flatMap((concern) =>
      readdirSync(join(root, concern, 'launchd')).map((name) => ({ concern, name })),
    )
    .find(({ name }) => name.endsWith('.plist.template'))!
  const text = readFileSync(join(root, template.concern, 'launchd', template.name), 'utf8')
  const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1]!
  const agents = join(home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(
    join(agents, `${label}.plist`),
    '<key>EnvironmentVariables</key><dict><key>HUB_HOSTED_URL</key></dict>',
  )

  const report = await migrateOperatorEnvironment(home, adapters())

  expect(report.followUps).toHaveLength(1)
  expect(report.backupDirectory).toBeNull()
  expect(report.restoreCommand).toBeNull()
})
