#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { decideCeiling } from './quality/ceiling-decision'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/file-ceiling.json`
const STATE_LABEL = 'scripts/quality/file-ceiling.json'
const CEILING = 1000
const SOURCE_ROOTS = [
  'orchestrator/src',
  'orchestrator/test',
  'hub/src',
  'hub/web/src',
  'shared',
  'scripts',
]

export const GENERATED_EXCLUSIONS = [
  /^hub\/web\/src\/routeTree\.gen\.ts$/,
  /(^|\/)migrations\/meta\//,
]

function sourceFiles(): string[] {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const absolute = resolve(directory, entry)
      if (statSync(absolute).isDirectory()) visit(absolute)
      else if (/\.tsx?$/.test(entry)) files.push(relative(ROOT, absolute))
    }
  }
  for (const directory of SOURCE_ROOTS) visit(resolve(ROOT, directory))
  return files.filter((path) => !GENERATED_EXCLUSIONS.some((pattern) => pattern.test(path))).sort()
}

export function measuredSourceFiles() {
  return sourceFiles().map((path) => ({ path, absolute: resolve(ROOT, path) }))
}

/**
 * Code lines only: blank lines and comment lines are not counted, so a reasoned
 * comment never costs a file its room. A line that opens a block comment and
 * every line until it closes is a comment line.
 */
function codeLines(content: string): number {
  let count = 0
  let inBlock = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line === '' || line.startsWith('//')) continue
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true
      continue
    }
    count += 1
  }
  return count
}

type FileMeasurement = { path: string; lines: number }
type Reporter = Pick<Console, 'error' | 'log'>

type FileCeilingOptions = {
  exists?: (path: string) => boolean
  measure?: () => FileMeasurement[]
  reporter?: Reporter
  stateFile?: string
}

function readState(stateFile: string): Record<string, number> {
  if (!existsSync(stateFile)) return {}
  return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, number>
}

function writeState(stateFile: string, state: Record<string, number>) {
  const ordered = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(stateFile, `${JSON.stringify(ordered, null, 2)}\n`)
}

function measureFiles(): FileMeasurement[] {
  return measuredSourceFiles().map((file) => ({
    path: file.path,
    lines: codeLines(readFileSync(file.absolute, 'utf8')),
  }))
}

export function checkFileCeiling(options: FileCeilingOptions = {}) {
  const stateFile = options.stateFile ?? STATE_FILE
  const reporter = options.reporter ?? console
  const measured = (options.measure ?? measureFiles)()
  const pathExists = options.exists ?? ((path: string) => existsSync(resolve(ROOT, path)))
  const frozen = readState(stateFile)
  const next = { ...frozen }
  const violations: string[] = []
  const tightenings: string[] = []
  for (const { path, lines } of measured) {
    const decision = decideCeiling({
      key: path,
      value: lines,
      frozen: frozen[path],
      ceiling: CEILING,
    })
    if (decision === 'lower') {
      next[path] = lines
      tightenings.push(`${STATE_LABEL}: ${path} tightened ${frozen[path]} -> ${lines}`)
    }
    if (decision === 'remove') {
      delete next[path]
      tightenings.push(`${STATE_LABEL}: ${path} tightened ${frozen[path]} -> ${lines}`)
    }
    if (decision === 'fail') {
      violations.push(
        `${path}: ${lines} code lines, frozen at ${frozen[path] ?? CEILING}; ` +
          'split a concern out (architecture-rules 15)',
      )
    }
  }
  for (const path of Object.keys(next)) {
    if (!pathExists(path)) {
      delete next[path]
      tightenings.push(`${STATE_LABEL}: ${path} tightened ${frozen[path]} -> removed`)
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(frozen)) writeState(stateFile, next)
  for (const tightening of tightenings) reporter.error(tightening)
  for (const violation of violations) reporter.error(violation)
  if (tightenings.length) {
    reporter.error(`baseline tightened; commit ${STATE_LABEL} and re-run (architecture-rules 15)`)
  }
  if (violations.length || tightenings.length) {
    return false
  }
  reporter.log(`check-file-ceiling: ok (${measured.length} files)`)
  return true
}

if (import.meta.main && !checkFileCeiling()) process.exit(1)
