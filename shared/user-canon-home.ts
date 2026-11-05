/** Plain locations where supported harnesses read user canon. */
export const USER_CANON_HOME_MAPPINGS = [
  {
    harness: 'claude',
    label: 'Claude Code',
    defaultDirectory: '.claude',
    homeOverrideEnvironment: null,
    entry: { canon: 'AGENTS.md', home: 'CLAUDE.md' },
    rules: { canonPrefix: '.agents/rules/', homeDirectory: 'rules' },
  },
  {
    harness: 'codex',
    label: 'Codex',
    defaultDirectory: '.codex',
    homeOverrideEnvironment: 'CODEX_HOME',
    entry: { canon: 'AGENTS.md', home: 'AGENTS.md' },
    rules: null,
  },
  {
    harness: 'grok',
    label: 'Grok',
    defaultDirectory: '.grok',
    homeOverrideEnvironment: 'GROK_HOME',
    entry: { canon: 'AGENTS.md', home: 'AGENTS.md' },
    rules: null,
  },
] as const

export type UserCanonHomeMapping = (typeof USER_CANON_HOME_MAPPINGS)[number]
