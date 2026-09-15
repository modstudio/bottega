import { readFileSync } from 'node:fs'
import { basename, dirname, join, normalize, relative } from 'node:path'
import { importSpecifiers } from './import-scanner.ts'

export type ImportCycle = string[]

type AllowedCycle = { cycle: ImportCycle; reason: string }

/** Known production import cycles. Entries may be removed, never added without a recorded reason. */
export const ALLOWED_IMPORT_CYCLES: AllowedCycle[] = [
  {
    cycle: ['canon.ts', 'docs.ts', 'canon.ts'],
    reason:
      'Pre-existing operator-doc/canon compilation cycle outside the three specified inversions.',
  },
]

function productionFiles(root: string): string[] {
  return [...new Bun.Glob('**/*.ts').scanSync({ cwd: root, absolute: true })]
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.fixtures.ts'))
    .sort()
}

function resolveRelative(source: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  const path = normalize(join(dirname(source), specifier))
  for (const candidate of [path, `${path}.ts`, join(path, 'index.ts')]) {
    if (files.has(candidate)) return candidate
  }
  return null
}

function canonicalCycle(cycle: ImportCycle): ImportCycle {
  const body = cycle.slice(0, -1)
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)])
  const winner = rotations.map((item) => item.join('\0')).sort()[0]!
  const canonical = winner.split('\0')
  return [...canonical, canonical[0]!]
}

/** Return every elementary directed cycle among production TypeScript files. */
export function findImportCycles(root: string): ImportCycle[] {
  const files = productionFiles(root)
  const fileSet = new Set(files)
  const graph = new Map(
    files.map((file) => {
      const scan = importSpecifiers(readFileSync(file, 'utf8'))
      const imports = [...scan.specifiers, ...scan.typeOnlySpecifiers]
        .map((specifier) => resolveRelative(file, specifier, fileSet))
        .filter((path): path is string => path !== null)
      return [file, [...new Set(imports)].sort()] as const
    }),
  )
  const found = new Map<string, ImportCycle>()

  for (const start of files) {
    const visited = new Set([start])
    const path = [start]
    const visit = (node: string) => {
      for (const next of graph.get(node) ?? []) {
        if (next === start) {
          const cycle = canonicalCycle([...path, start].map((file) => relative(root, file)))
          found.set(cycle.join(' -> '), cycle)
        } else if (!visited.has(next)) {
          visited.add(next)
          path.push(next)
          visit(next)
          path.pop()
          visited.delete(next)
        }
      }
    }
    visit(start)
  }
  return [...found.values()].sort((a, b) => a.join('\0').localeCompare(b.join('\0')))
}

export function unexpectedImportCycles(
  cycles: ImportCycle[],
  allowlist: AllowedCycle[] = ALLOWED_IMPORT_CYCLES,
): ImportCycle[] {
  const allowed = new Set(allowlist.map(({ cycle }) => canonicalCycle(cycle).join(' -> ')))
  return cycles.filter((cycle) => !allowed.has(canonicalCycle(cycle).join(' -> ')))
}

if (import.meta.main) {
  const root = join(dirname(import.meta.dir), 'orchestrator', 'src')
  const cycles = findImportCycles(root)
  for (const cycle of cycles) console.log(cycle.join(' -> '))
  const unexpected = unexpectedImportCycles(cycles)
  const present = new Set(cycles.map((cycle) => canonicalCycle(cycle).join(' -> ')))
  const stale = ALLOWED_IMPORT_CYCLES.filter(
    ({ cycle }) => !present.has(canonicalCycle(cycle).join(' -> ')),
  )
  if (unexpected.length || stale.length) {
    if (stale.length) {
      console.error(
        `check-import-cycles: ${stale.length} stale allowlist entry/entries must be removed`,
      )
    }
    if (unexpected.length)
      console.error(`check-import-cycles: ${unexpected.length} unexpected cycle(s)`)
    process.exit(1)
  }
  console.log(`check-import-cycles: ok (${cycles.length} allowed cycle(s))`)
}
