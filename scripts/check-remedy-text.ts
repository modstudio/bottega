import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unknownBottegaCommandWords } from '../orchestrator/src/doc/doc-command-mentions.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { PLATFORM_COMMAND_WORDS } from '../shared/command-spellings.ts'

const startedAt = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

// Mirrors the production surfaces and exclusions owned by check-refusal-remedy.ts.
const sourceRoots = ['orchestrator/src', 'shared', 'hub/src', 'cli', 'scripts'] as const

const proseAllowlist = new Map([
  ['task client', 'names the hosted task client in a test-safety refusal, not a command'],
  ['note client', 'names the hosted note client in a test-safety refusal, not a command'],
  ['report client', 'names the hosted report client in a test-safety refusal, not a command'],
  ['task lookup', 'describes a failed task lookup operation, not a command'],
  ['task read', 'describes a task read operation with no reader, not a command'],
  ['task document', 'describes a workflow text document, not a command'],
  ['machine setup chooses', 'continues prose after the runnable machine setup command'],
  ['machine setup requires', 'continues prose after the runnable machine setup command'],
  ['record outbox shows', 'continues prose after the runnable record outbox command'],
  ['machine init-db', 'names a registered hidden machine route omitted from public spellings'],
  ['machine journal', 'names a registered hidden machine route omitted from public spellings'],
  ['release with', 'describes releasing with the installer, not a command'],
  ['release that', 'describes the release that wrote a store, not a command'],
  ['pr from', 'describes a pull request source, not a command'],
  ['pr requires', 'describes a pull request precondition, not a command'],
])

function sourceFiles(directory: string): string[] {
  return readdirSync(`${root}/${directory}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(path)
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.d.ts') ||
      path === 'scripts/check-remedy-text.ts'
    )
      return []
    return [path]
  })
}

function insideEscapedBackticks(line: string, index: number): boolean {
  return line.slice(0, index).split('\\`').length % 2 === 0
}

const commandCitation = /\$\{PLATFORM_SLUG\}((?: [a-z][a-z0-9-]*)+)/g

/** Pure classification of unregistered command citations in one source line. */
export function remedyCommandCitationFindings(
  line: string,
  knownCommandWords: readonly string[] = PLATFORM_COMMAND_WORDS,
): string[] {
  if (!line.includes('${PLATFORM_SLUG}')) return []
  const topLevelWords = new Set(knownCommandWords.map((command) => command.split(' ')[0]!))
  const findings: string[] = []
  for (const match of line.matchAll(commandCitation)) {
    const words = match[1]!.trim().split(' ')
    if (!insideEscapedBackticks(line, match.index) && !topLevelWords.has(words[0]!)) continue
    const mention = unknownBottegaCommandWords(words, knownCommandWords)
    if (!mention) continue
    const command = mention.slice(`${PLATFORM_SLUG} `.length)
    if (proseAllowlist.has(command)) continue
    findings.push(mention)
  }
  return findings
}

function check(): boolean {
  const findings = sourceRoots
    .flatMap(sourceFiles)
    .sort()
    .flatMap((path) =>
      readFileSync(`${root}/${path}`, 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          const lineFindings = line.includes('git pull')
            ? [`${path}:${index + 1}: forbidden remedy text 'git pull'`]
            : []
          lineFindings.push(
            ...remedyCommandCitationFindings(line).map(
              (mention) => `${path}:${index + 1}: ${mention} is not a registered command`,
            ),
          )
          return lineFindings
        }),
    )
  for (const finding of findings) console.error(finding)
  if (findings.length) return false
  console.log(`remedy text guard: ${(performance.now() - startedAt).toFixed(1)}ms`)
  return true
}

if (import.meta.main && !check()) process.exit(1)
