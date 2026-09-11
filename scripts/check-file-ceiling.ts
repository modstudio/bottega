#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { decideCeiling } from './quality/ceiling-decision'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/file-ceiling.json`
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

function readState(): Record<string, number> {
  if (!existsSync(STATE_FILE)) return {}
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, number>
}

function writeState(state: Record<string, number>) {
  const ordered = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(STATE_FILE, `${JSON.stringify(ordered, null, 2)}\n`)
}

export function checkFileCeiling() {
  const frozen = readState()
  const next = { ...frozen }
  const violations: string[] = []
  for (const file of measuredSourceFiles()) {
    const lines = newlineTerminatedLines(readFileSync(file.absolute, 'utf8'))
    const decision = decideCeiling({
      key: file.path, value: lines, frozen: frozen[file.path], ceiling: CEILING,
    })
    if (decision === 'lower') next[file.path] = lines
    if (decision === 'remove') delete next[file.path]
    if (decision === 'fail') {
      violations.push(
        `${file.path}: ${lines} lines, frozen at ${frozen[file.path] ?? CEILING}; ` +
        'split a concern out (architecture-rules 15)',
      )
    }
  }
  for (const path of Object.keys(next)) {
    if (!existsSync(resolve(ROOT, path))) delete next[path]
  }
  if (JSON.stringify(next) !== JSON.stringify(frozen)) writeState(next)
  if (violations.length) {
    for (const violation of violations) console.error(violation)
    return false
  }
  console.log(`check-file-ceiling: ok (${measuredSourceFiles().length} files)`)
  return true
}

if (import.meta.main && !checkFileCeiling()) process.exit(1)
