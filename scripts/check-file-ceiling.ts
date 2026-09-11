#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { decideCeiling } from './quality/ceiling-decision'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/file-ceiling.json`
const STATE_LABEL = 'scripts/quality/file-ceiling.json'
const CEILING = 500
const SOURCE_ROOTS = [
  'orchestrator/src', 'orchestrator/test', 'hub/src', 'hub/web/src', 'shared', 'scripts',
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

function newlineTerminatedLines(content: string) {
  return content.match(/\n/g)?.length ?? 0
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
    lines: newlineTerminatedLines(readFileSync(file.absolute, 'utf8')),
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
      key: path, value: lines, frozen: frozen[path], ceiling: CEILING,
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
        `${path}: ${lines} lines, frozen at ${frozen[path] ?? CEILING}; ` +
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
    reporter.error(
      `baseline tightened; commit ${STATE_LABEL} and re-run (architecture-rules 15)`,
    )
  }
  if (violations.length || tightenings.length) {
    return false
  }
  reporter.log(`check-file-ceiling: ok (${measured.length} files)`)
  return true
}

if (import.meta.main && !checkFileCeiling()) process.exit(1)
