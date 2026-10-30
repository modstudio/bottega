import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const startedAt = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = `${root}hub/src`
const forbidden = ['hosted hub refused', 'unknown error'] as const

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return productionFiles(path)
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    if (path === `${sourceRoot}/hosted-refusal.ts`) return []
    return [path]
  })
}

const findings = productionFiles(sourceRoot).flatMap((path) => {
  const relative = path.slice(root.length)
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      forbidden.flatMap((text) =>
        line.includes(text)
          ? [`${relative}:${index + 1}: forbidden hosted refusal text '${text}'`]
          : [],
      ),
    )
})

if (findings.length) {
  console.error(findings.join('\n'))
  process.exit(1)
}

console.log(`hosted refusal text guard: ${(performance.now() - startedAt).toFixed(1)}ms`)
