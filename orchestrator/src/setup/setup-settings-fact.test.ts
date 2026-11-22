import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PRODUCT_HOOKS, withMachineProductHooks } from '../settings/settings-machine-hooks.ts'
import { gatherSetupSettingsFact } from './setup-settings-fact.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('setup settings fact reports matching and absent hooks from the local settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-settings-fact-'))
  temporary.push(home)
  const claudeHome = join(home, '.claude')
  const assetRoot = join(home, 'installation')
  mkdirSync(claudeHome)
  const runtime = {
    executable: join(assetRoot, 'bin', PLATFORM_SLUG),
    scriptPath: (file: (typeof PRODUCT_HOOKS)[number]['script']) =>
      join(assetRoot, 'orchestrator', 'hooks', file),
  }
  const settings = withMachineProductHooks(
    { permissions: {}, hooks: {} },
    join(home, 'orchestrator.db'),
    'on',
    runtime,
  ).settings
  const first = PRODUCT_HOOKS[0]!
  const groups = settings.hooks?.[first.event] as Array<{
    matcher?: string
    hooks: Array<{ command: string }>
  }>
  const group = groups.find((candidate) => candidate.matcher === first.matcher)!
  group.hooks.shift()
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify(settings))

  const fact = gatherSetupSettingsFact(
    { HOME: home },
    { sessionPresent: () => true, assetRoot: () => assetRoot },
  )

  expect(fact.state).toBe('signed-in')
  expect(fact.hooks[0]).toEqual({
    event: first.event,
    matcher: first.matcher,
    script: first.script,
    state: 'missing',
  })
  expect(fact.hooks.some((hook) => hook.state === 'present')).toBe(true)
})
