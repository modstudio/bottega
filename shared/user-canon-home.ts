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

/** Maps one canon slug to the relative file path read by a supported harness. */
export function mapUserCanonHomePath(mapping: UserCanonHomeMapping, slug: string): string | null {
  if (slug === mapping.entry.canon) return mapping.entry.home
  if (!mapping.rules || !slug.startsWith(mapping.rules.canonPrefix)) return null
  const name = slug.slice(mapping.rules.canonPrefix.length)
  return /^[^/]+\.md$/.test(name) ? `${mapping.rules.homeDirectory}/${name}` : null
}
