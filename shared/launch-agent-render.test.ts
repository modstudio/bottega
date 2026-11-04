import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIX_DEFECT_BACKSTOP_SECONDS,
  LAUNCH_AGENT_PLACEHOLDERS,
  launchAgentProgramPath,
  launchAgentRenderCommandValues,
  MONITOR_BACKSTOP_SECONDS,
  renderLaunchAgentTemplate,
} from './launch-agent-render.ts'

const LEGACY_SED_HASHES: Record<string, string> = {
  'ops/launchd/com.user.brew-auto-upgrade.plist.template':
    '71e1a96cf062baaa8bea126f75c1711e0d38fd6130b06600e106fefb2086d776',
  'ops/launchd/com.user.docker-prune.plist.template':
    '04cacc9e76cdb9cd2ba1c60ae79e2335faefe98f8b6e4d1d210ddf7ca9eb3dcb',
  'ops/launchd/com.user.hub-note-maintenance.plist.template':
    '599b1a1718b51153cbc88a05e55d05c21359635ba3c97cc2b8ea1df65d8a4371',
  'ops/launchd/com.user.local-model-tunnel.plist.template':
    '32d96e0b7d305c7dd4339012436d4b47096919a3d8083779e4e48d6f72be25c7',
  'ops/launchd/com.user.orch-board-watch.plist.template':
    '477024762f9112350f9e4e51930f259a03740c285db5e964f63cf7d57fc05ac2',
  'ops/launchd/com.user.orch-canon-audit.plist.template':
    '23de580c7e8110f1987aa2ee4f0fb495a8c31e3aeb1733ca406e1f8c2a3a4ca6',
  'ops/launchd/com.user.orch-canon-eval.plist.template':
    'e3dd8b7f9a359a902997a07d8e8be5a3dbe3278cb8dd8e69dc9a75dca8f6914f',
  'ops/launchd/com.user.orch-canon-mirror.plist.template':
    'a1d1bef8e01abe68a0e7ecf82733fb9a94aa70db0741667790aa21532591c81a',
  'ops/launchd/com.user.orch-fix-defect.plist.template':
    'f76a0af02b6b0a5a46fcb49ae75c2c343cdfa03f864e6d6cdab4d5cb3d7fe76c',
  'ops/launchd/com.user.orch-load-sample.plist.template':
    '7ed8c13f6fd667a99708308993c9f0fae60df993013f018ffc4e137ba63c2d22',
  'ops/launchd/com.user.orch-monitor.plist.template':
    'cf7d9680587e6c162a2dfa16015e7323f6d04ac8f18cdc236a7566ce4ef33674',
  'ops/launchd/com.user.orch-record-sync.plist.template':
    '4f07b88c070f2863dd742cb72fdae3c59954ebd0ba5acafcddfceaae855590ec',
  'ops/launchd/com.user.orch-spare.plist.template':
    'af23849f34e5e6bf832582ec9344754eaccd2270e34d3909626c0d6d6b0669d8',
  'ops/launchd/com.user.orch-sweep.plist.template':
    'd75b4430b1d97dc0bef02614f0a578925a401d6aca376f0685bccf11b65a6949',
  'ops/launchd/com.user.projects-morning-refresh.plist.template':
    '36c980ed024936a7de0b9365087bbc17a6b8930cc2eac146d78edcabfc25e6c2',
  'ops/launchd/com.user.record-tunnel.plist.template':
    'd959097296106f8f6e86a29ee9596e9b55e3df54e923f6f740c6dabaf40dbb5d',
  'hub/launchd/com.user.hub-collect.plist.template':
    '3317e17286728f3addd8e6a6542a48f28e6cb6dc3a133ba90c6e3b73ab3c2d15',
  'hub/launchd/com.user.hub-serve.plist.template':
    '1ea403c069780010fb6661cc8620dbedfcc9a3a17cc854329044532153894efe',
}

describe('launch-agent renderer', () => {
  test('matches the former sed output for every installer template', () => {
    const root = join(import.meta.dir, '..')
    const templates = ['ops/launchd', 'hub/launchd'].flatMap((directory) =>
      readdirSync(join(root, directory))
        .filter((name) => name.endsWith('.plist.template'))
        .map((name) => `${directory}/${name}`),
    )
    const values = Object.fromEntries(
      LAUNCH_AGENT_PLACEHOLDERS.map((placeholder, index) => [placeholder, `value-${index}`]),
    ) as Parameters<typeof renderLaunchAgentTemplate>[1]

    expect(templates.sort()).toEqual(Object.keys(LEGACY_SED_HASHES).sort())
    for (const path of templates) {
      const rendered = renderLaunchAgentTemplate(readFileSync(join(root, path), 'utf8'), values)
      expect(createHash('sha256').update(rendered).digest('hex')).toBe(LEGACY_SED_HASHES[path]!)
    }
  })

  test('reads the first launchd program path', () => {
    expect(
      launchAgentProgramPath(
        '<key>ProgramArguments</key><array><string>/missing/program</string></array>',
      ),
    ).toBe('/missing/program')
  })

  test('the renderer CLI supplies the shared backstop defaults when callers omit them', () => {
    const values = launchAgentRenderCommandValues([])
    expect(values.__MONITOR_BACKSTOP_SECONDS__).toBe(String(MONITOR_BACKSTOP_SECONDS))
    expect(values.__FIX_DEFECT_BACKSTOP_SECONDS__).toBe(String(FIX_DEFECT_BACKSTOP_SECONDS))

    const overridden = launchAgentRenderCommandValues(['__MONITOR_BACKSTOP_SECONDS__', '60'])
    expect(overridden.__MONITOR_BACKSTOP_SECONDS__).toBe('60')
  })

  test('the renderer CLI leaves unpassed placeholders unresolved', () => {
    const values = launchAgentRenderCommandValues(['__HOME__', '/Users/example'])
    expect(values.__INSTALL_ROOT__).toBeUndefined()
    expect(() => renderLaunchAgentTemplate('__HOME__ __INSTALL_ROOT__', values)).toThrow(
      'unresolved launch-agent placeholder(s): __INSTALL_ROOT__',
    )
  })
})
