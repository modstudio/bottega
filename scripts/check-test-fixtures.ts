import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const orchestrator = resolve(root, 'orchestrator')
const failures: string[] = []

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function productionPath(source: string): boolean {
  return source.startsWith('../src/') || source.startsWith('../../shared/')
}

function importedProductionBindings(source: string): Set<string> {
  const bindings = new Set<string>()
  const imports = source.matchAll(/import\s*{([^}]*)}\s*from\s*['"]([^'"]+)['"]/gs)
  for (const match of imports) {
    if (!productionPath(match[2]!)) continue
    for (const entry of match[1]!.split(',')) {
      const binding = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()
      if (binding) bindings.add(binding)
    }
  }
  return bindings
}

function exportedBindings(source: string): Set<string> {
  const bindings = new Set<string>()
  for (const match of source.matchAll(/export\s*{([^}]*)}(?:\s*from\s*['"]([^'"]+)['"])?/gs)) {
    if (match[2] && productionPath(match[2])) {
      failures.push('re-exports production bindings')
      continue
    }
    for (const entry of match[1]!.split(',')) {
      const binding = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]
      if (binding) bindings.add(binding)
    }
  }
  return bindings
}

function checkFixture(path: string): void {
  if (path.endsWith('/preload.ts') || !path.endsWith('.ts')) return
  const source = readFileSync(path, 'utf8')
  const label = relative(root, path)
  const before = failures.length
  if (/export\s+const\s*{[^}]+}\s*=\s*await\s+import\(\s*['"](?:\.\.\/src\/|\.\.\/\.\.\/shared\/)/s.test(source)) {
    failures.push('re-exports production bindings obtained from await import')
  }
  const imported = importedProductionBindings(source)
  const exported = exportedBindings(source)
  for (const binding of imported) {
    if (exported.has(binding)) failures.push(`re-exports imported production binding ${binding}`)
  }
  for (let index = before; index < failures.length; index += 1) failures[index] = `${label}: ${failures[index]}`
}

function braceDepthBeforeLines(source: string): number[] {
  const depths: number[] = []
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (const line of source.split('\n')) {
    depths.push(depth)
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"' || char === '`') quote = char
      else if (char === '{') depth += 1
      else if (char === '}') depth = Math.max(0, depth - 1)
    }
  }
  return depths
}

function checkTest(path: string): void {
  if (!/\.(?:test|spec)\.tsx?$/.test(path)) return
  const source = readFileSync(path, 'utf8')
  const label = relative(root, path)
  if (/from\s*['"][^'"]*test\/fixture\.ts['"]/.test(source)) {
    failures.push(`${label}: imports orchestrator/test/fixture.ts`)
  }
  const lines = source.split('\n')
  const depths = braceDepthBeforeLines(source)
  for (let index = 0; index < lines.length; index += 1) {
    if (depths[index] !== 0) continue
    if (/(?:delete\s+process\.env\.(?:PATH|HOME|ORCH_SANDBOX)\b|process\.env\.(?:PATH|HOME|ORCH_SANDBOX)\s*=)/.test(lines[index]!)) {
      failures.push(`${label}:${index + 1}: mutates test environment at module top level`)
    }
  }
}

for (const path of filesUnder(resolve(orchestrator, 'test'))) checkFixture(path)
for (const path of filesUnder(orchestrator)) checkTest(path)

if (failures.length) {
  console.error('test fixture boundary failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('test fixture boundary passed')
