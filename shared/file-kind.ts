export type FileKind = 'generated' | 'test' | 'docs' | 'config' | 'product'

const RULES: [FileKind, RegExp][] = [
  ['docs', /^(?:\.claude\/rules|\.agents\/rules\/contexts)$/],
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
  ['test', /_test\.(go|py|rb)$/],
  ['test', /(^|\/)(cypress|e2e|playwright)\//],
  ['docs', /\.mdx?$/],
  ['docs', /(^|\/)docs?\//i],
  ['config', /\.(ya?ml|toml|ini|conf)$/],
  ['config', /(^|\/)\.[\w.-]+$/],
  ['config', /\.config\.[jt]s$/],
  ['config', /(^|\/)(tsconfig|package)\.json$/],
]

export function categorizeFile(file: string): FileKind {
  for (const [kind, re] of RULES) if (re.test(file)) return kind
  return 'product'
}
