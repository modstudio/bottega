import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { GROUPS, ROUTES } from '../cli/routes.ts'
import { program as hubProgram } from '../hub/src/cli-program.ts'
import { program as orchestratorProgram } from '../orchestrator/src/cli/program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const startedAt = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoots = [`${root}orchestrator/src`, `${root}hub/src`, `${root}shared`]

const proseAllowlist = new Map([
  ['task client', 'names the hosted task client in a test-safety refusal, not a command'],
  ['note client', 'names the hosted note client in a test-safety refusal, not a command'],
  ['report client', 'names the hosted report client in a test-safety refusal, not a command'],
])

function commandAt(program: Command, path: readonly string[]): Command | null {
  let command = program
  for (const name of path) {
    const next = command.commands.find(
      (candidate) => candidate.name() === name || candidate.aliases().includes(name),
    )
    if (!next) return null
    command = next
  }
  return command
}

function registeredGroupVerbs(): Map<string, Set<string>> {
  const verbs = new Map(GROUPS.map(([group]) => [group, new Set<string>()]))
  const programs = { orch: orchestratorProgram, hub: hubProgram } as const
  for (const route of ROUTES) {
    const groupVerbs = verbs.get(route.command[0]!)
    if (!groupVerbs) continue
    if (route.command[1]) groupVerbs.add(route.command[1])
    if (route.command.length !== 1 || (route.owner !== 'orch' && route.owner !== 'hub')) continue
    const registered = commandAt(programs[route.owner], route.argv ?? [])
    if (!registered) throw new Error(`registered route ${route.command.join(' ')} has no owner command`)
    for (const command of registered.commands) {
      groupVerbs.add(command.name())
      for (const alias of command.aliases()) groupVerbs.add(alias)
    }
  }
  return verbs
}

function isOperationProse(command: string, before: string, after: string): boolean {
  if (command === 'task lookup') return after.startsWith(' failed:')
  if (command === 'task read') {
    return before.endsWith('a ') && after.startsWith(' and no reader was provided')
  }
  if (command === 'release with') return after.startsWith(' the installer')
  if (command === 'release that') return after.startsWith(' wrote this store')
  if (command === 'pr from') return after.startsWith(' a registered checkout')
  if (command === 'pr requires') return after.startsWith(' a checked-out branch')
  return false
}

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return productionFiles(path)
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

const groupVerbs = registeredGroupVerbs()
const commandCitation = /\$\{PLATFORM_SLUG\} ([a-z][a-z-]*) ([a-z][a-z-]*)/g
const findings = sourceRoots.flatMap(productionFiles).flatMap((path) => {
  const relative = path.slice(root.length)
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const lineFindings = line.includes('git pull')
        ? [`${relative}:${index + 1}: forbidden remedy text 'git pull'`]
        : []
      for (const match of line.matchAll(commandCitation)) {
        const group = match[1]!
        const verb = match[2]!
        const registered = groupVerbs.get(group)
        if (!registered || registered.has(verb)) continue
        const command = `${group} ${verb}`
        if (proseAllowlist.has(command)) continue
        const before = line.slice(0, match.index)
        const after = line.slice(match.index + match[0].length)
        if (isOperationProse(command, before, after)) continue
        lineFindings.push(
          `${relative}:${index + 1}: ${PLATFORM_SLUG} ${command} is not a registered command`,
        )
      }
      return lineFindings
    })
})

if (findings.length) {
  console.error(findings.join('\n'))
  process.exit(1)
}

console.log(`remedy text guard: ${(performance.now() - startedAt).toFixed(1)}ms`)
