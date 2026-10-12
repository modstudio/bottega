#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ChangeFacts, type Finding, ratchetDecision } from '../shared/ratchet'
import { openChangeView } from './change-view'
import { resolveLandingBase } from './landing-base'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const CEILING = 1000
const SOURCE_ROOTS = [
  'orchestrator/src',
  'orchestrator/test',
  'hub/src',
  'hub/web/src',
  'shared',
  'scripts',
]

const GENERATED_EXCLUSIONS = [/^hub\/web\/src\/routeTree\.gen\.ts$/, /(^|\/)migrations\/meta\//]

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

export function hasFormatSuppression(content: string): boolean {
  return /^[\t ]*(?:\/\/|\/\*)[\t ]*biome-ignore[\t ]+format\b/m.test(content)
}

type FileMeasurement = { path: string; lines: number; ignoresFormat?: boolean }
type Reporter = Pick<Console, 'error' | 'log'>

type FileCeilingOptions = {
  change?: { base: FileMeasurement[]; head: FileMeasurement[]; facts: ChangeFacts }
  measureSuppressions?: () => FileMeasurement[]
  reporter?: Reporter
}

function measureFiles(): FileMeasurement[] {
  return measuredSourceFiles().map((file) => {
    const content = readFileSync(file.absolute, 'utf8')
    return {
      path: file.path,
      lines: codeLines(content),
      ignoresFormat: hasFormatSuppression(content),
    }
  })
}

function formatSuppressionViolations(path: string, ignoresFormat: boolean | undefined) {
  if (!ignoresFormat) return []
  return [
    `${path}: biome-ignore format is forbidden in measured source; ` +
      'split a concern out (canon 10-code: Respect the file ceiling)',
  ]
}

function fileLengthFinding(measurement: FileMeasurement): Finding | null {
  if (measurement.lines <= CEILING) return null
  return {
    file: measurement.path,
    line: 1,
    rule: 'file-length',
    message: `file has ${measurement.lines} code lines; limit ${CEILING}`,
    symbol: measurement.path,
    measure: measurement.lines,
  }
}

export function fileLengthDecision({
  base,
  head,
  facts,
}: {
  base: FileMeasurement[]
  head: FileMeasurement[]
  facts: ChangeFacts
}) {
  return ratchetDecision({
    base: base.flatMap((measurement) => fileLengthFinding(measurement) ?? []),
    head: head.flatMap((measurement) => fileLengthFinding(measurement) ?? []),
    change: facts,
  })
}

function isMeasuredSourcePath(path: string) {
  return (
    /\.tsx?$/.test(path) &&
    SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
    !GENERATED_EXCLUSIONS.some((pattern) => pattern.test(path))
  )
}

function changedFileMeasurements() {
  const base = resolveLandingBase(ROOT, 'check-file-ceiling').commit
  const view = openChangeView({ cwd: ROOT, base, mode: 'commit' })
  const before: FileMeasurement[] = []
  const after: FileMeasurement[] = []
  for (const entry of view.entries) {
    if (entry.status === 'D' || !isMeasuredSourcePath(entry.path)) continue
    const headContent = view.headContent(entry.path)
    if (headContent.status === 'absent') {
      throw new Error(
        `check-file-ceiling could not read HEAD:${entry.path}; restore the blob and retry`,
      )
    }
    after.push({ path: entry.path, lines: codeLines(headContent.text) })
    const baseContent = view.baseContent(entry.path)
    if (baseContent.status === 'absent') continue
    before.push({
      path: view.facts.renames.get(entry.path) ?? entry.path,
      lines: codeLines(baseContent.text),
    })
  }
  return { base: before, head: after, facts: view.facts }
}

function fileLengthViolation(finding: ReturnType<typeof fileLengthDecision>[number]) {
  const previous = finding.reason === 'grew' ? `, previous count ${finding.previousMeasure}` : ''
  return (
    `${finding.file}: ${finding.measure} code lines, limit ${CEILING}${previous}; ` +
    'split a concern out (canon 10-code: Respect the file ceiling)'
  )
}

export function checkFileCeiling(options: FileCeilingOptions = {}) {
  const reporter = options.reporter ?? console
  const measured = (options.measureSuppressions ?? measureFiles)()
  const violations = measured.flatMap(({ path, ignoresFormat }) =>
    formatSuppressionViolations(path, ignoresFormat),
  )
  const change = options.change ?? changedFileMeasurements()
  violations.push(...fileLengthDecision(change).map(fileLengthViolation))
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log(`check-file-ceiling: ok (${measured.length} files)`)
  return true
}

if (import.meta.main) {
  try {
    if (!checkFileCeiling()) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
