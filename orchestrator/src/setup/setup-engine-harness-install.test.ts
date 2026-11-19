import { expect, test } from 'bun:test'
import { proposeSetup, type SetupAgent } from './setup-engine.ts'
import type { SetupFacts } from './setup-facts.ts'
import { HARNESS_MCP_CATALOGUE } from './setup-mcp.ts'
import { planSetupActions, recommendedAnswers } from './setup-planner.ts'

const machine = {
  machineLevel: 'full',
  globalUse: 'on',
  installationKind: null,
  schedules: [],
  scheduleLinger: null,
  scheduleUser: null,
  keystore: { value: 'keychain', source: { kind: 'default' }, keychainUsable: true },
  recordApiUrl: 'https://api.example.test',
  recordApiConfigured: true,
  os: { platform: 'darwin', arch: 'arm64', wsl: false },
  git: { path: '/bin/git', version: '1' },
  gh: { path: '/bin/gh', version: '1', loggedIn: true },
  sandboxRuntime: { available: true, fixes: [] },
} as unknown as SetupFacts

function machineWithHarness(
  name: keyof SetupFacts['harnesses'],
  path: string | null,
  platform: NodeJS.Platform,
): SetupFacts {
  return {
    ...machine,
    os: { platform, arch: 'x64', wsl: false },
    harnesses: {
      claude: { path: null, version: null, auth: 'unknown', mcp: null },
      codex: { path: null, version: null, auth: 'unknown', mcp: null },
      grok: { path: null, version: null, auth: 'unknown', mcp: null },
      opencode: { path: null, version: null, auth: 'unknown', mcp: null },
      goose: { path: null, version: null, auth: 'unknown', mcp: null },
      [name]: { path, version: path ? '1' : null, auth: path ? 'signed-in' : 'unknown', mcp: null },
    },
  }
}

const installCommands = {
  codex: {
    darwin: 'brew install --cask codex',
    linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
  },
  grok: {
    darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    linux: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  },
  goose: {
    darwin: 'brew install block-goose-cli',
    linux:
      'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
  },
} as const

const resolveLifecycle = () => ({ form: 'none' as const })
const agent = (harness: 'codex' | 'grok' | 'goose', enabled: boolean): SetupAgent => ({
  name: harness === 'goose' ? 'goose-agent' : harness,
  harness,
  enabled,
  probePassed: true,
})

for (const harness of ['codex', 'grok', 'goose'] as const) {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    test(`${harness} install decision on ${platform}`, () => {
      const plan = proposeSetup(
        resolveLifecycle,
        machineWithHarness(harness, null, platform),
        [],
        [],
        [agent(harness, true)],
      )
      const id = `harness:${harness}:install`
      const question = plan.questions.find((item) => item.id === id)
      if (platform === 'win32') {
        expect(question).toBeUndefined()
        expect(plan.notices).toContainEqual(
          expect.objectContaining({
            fix: expect.stringContaining(HARNESS_MCP_CATALOGUE[harness].documentation),
            blocking: false,
          }),
        )
        return
      }
      const command = installCommands[harness][platform]
      expect(question).toMatchObject({
        question: `Install ${harness}? Runs: \`${command}\``,
        recommendation: 'install',
        options: [
          expect.objectContaining({ id: 'install' }),
          expect.objectContaining({ id: 'skip' }),
        ],
      })
      expect(planSetupActions(plan, recommendedAnswers(plan))).toContainEqual({
        kind: 'install-harness',
        harness,
        route: HARNESS_MCP_CATALOGUE[harness].install[platform],
      })
      expect(planSetupActions(plan, { ...recommendedAnswers(plan), [id]: 'skip' })).toContainEqual({
        kind: 'skip-harness-install',
        harness,
        route: HARNESS_MCP_CATALOGUE[harness].install[platform],
      })
    })

    test(`${harness} present on ${platform} has no install decision`, () => {
      const plan = proposeSetup(
        resolveLifecycle,
        machineWithHarness(harness, `/bin/${harness}`, platform),
        [],
        [],
        [agent(harness, true)],
      )
      expect(plan.questions.some(({ id }) => id === `harness:${harness}:install`)).toBe(false)
      expect(plan.notices).toEqual([])
    })

    test(`${harness} disabled on ${platform} has no install decision`, () => {
      const plan = proposeSetup(
        resolveLifecycle,
        machineWithHarness(harness, null, platform),
        [],
        [],
        [agent(harness, false)],
      )
      expect(plan.questions.some(({ id }) => id === `harness:${harness}:install`)).toBe(false)
      expect(plan.notices).toEqual([])
    })
  }
}
