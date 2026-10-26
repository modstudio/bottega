export type FileKind = 'generated' | 'test' | 'docs' | 'config' | 'product'

const DOCS_DIRECTORY = /(^|\/)docs?\//i
const SRC_DIRECTORY = /(^|\/)src\//i

const RULES: [FileKind, RegExp][] = [
  ['docs', /^(?:\.claude\/rules|\.agents\/rules\/contexts)$/],
  ['generated', /(^|\/)migrations\/.*snapshot\.json$/],
  ['generated', /drizzle\/(.*snapshot\.json$|meta\/)/],
  [
    'generated',
    /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|composer\.lock|pnpm-lock\.yaml)$/,
  ],
  ['generated', /\.min\.(js|css)$/],
  ['generated', /(^|\/)(dist|build|vendor|node_modules)\//],
  ['generated', /\.(map|snap|svg|png|jpe?g|gif|ico|woff2?|ttf|pdf|lock)$/],
  ['generated', /(^|\/)__snapshots__\//],
  ['test', /\.(test|spec)\.[jt]sx?$/],
  ['test', /\.integration\.test\./],
  ['test', /(^|\/)__tests__\//],
  ['test', /(^|\/)tests?\//i],
  ['test', /Test\.php$/],
  // The hooks suite's process-driving cases keep the `process_` name so the
  // gate's unittest discovery never collects them, and their fixture is support
  // the two hook suites share; both are test code wherever they are reviewed.
  ['test', /(^|\/)orchestrator\/hooks\/process_[^/]+\.py$/],
  ['test', /(^|\/)orchestrator\/hooks\/[a-z_]+_fixture\.py$/],
  ['test', /(^|\/)test_[^/]+\.py$/],
  ['test', /_test\.(go|py|rb)$/],
  ['test', /(^|\/)(cypress|e2e|playwright)\//],
  ['docs', /\.mdx?$/],
  ['docs', DOCS_DIRECTORY],
  ['config', /\.(ya?ml|toml|ini|conf)$/],
  ['config', /(^|\/)\.[\w.-]+$/],
  ['config', /\.config\.[jt]s$/],
  ['config', /(^|\/)(tsconfig|package)\.json$/],
]

function srcComesBeforeDocsDirectory(file: string): boolean {
  const docsAt = file.search(DOCS_DIRECTORY)
  if (docsAt < 0) return false
  const srcAt = file.search(SRC_DIRECTORY)
  return srcAt >= 0 && srcAt < docsAt
}

export function categorizeFile(file: string): FileKind {
  for (const [kind, re] of RULES) {
    if (!re.test(file)) continue
    if (re === DOCS_DIRECTORY && srcComesBeforeDocsDirectory(file)) continue
    return kind
  }
  return 'product'
}
