import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const startedAt = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoots = [`${root}orchestrator/src`, `${root}hub/src`, `${root}shared`]

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return productionFiles(path)
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

const findings = sourceRoots.flatMap(productionFiles).flatMap((path) => {
  const relative = path.slice(root.length)
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      line.includes('git pull')
        ? [`${relative}:${index + 1}: forbidden remedy text 'git pull'`]
        : [],
    )
})

if (findings.length) {
  console.error(findings.join('\n'))
  process.exit(1)
}

console.log(`remedy text guard: ${(performance.now() - startedAt).toFixed(1)}ms`)
