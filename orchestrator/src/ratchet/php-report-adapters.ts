import { isAbsolute, relative, resolve } from 'node:path'
import type { Finding } from '../../../shared/ratchet.ts'

export const PHPSTAN_UNIDENTIFIED_RULE = 'phpstan'

export type MeasurePattern = { rule: string; pattern: string }

type AdapterOptions = {
  reportRoot: string
  measures?: MeasurePattern[]
  baseRenames?: Map<string, string>
}

type ReportMessage = {
  line?: unknown
  source?: unknown
  identifier?: unknown
  message?: unknown
  type?: unknown
}

function reportFiles(text: string, format: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `invalid ${format} JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const files = (value as { files?: unknown }).files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error(`${format} report has no files object`)
  }
  return files as Record<string, unknown>
}

function relativeReportPath(path: string, reportRoot: string): string {
  if (!isAbsolute(path)) return path
  const fromRoot = relative(resolve(reportRoot), resolve(path))
  if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    throw new Error(`report path is outside report root ${reportRoot}: ${path}`)
  }
  return fromRoot
}

function normalizedPath(path: string, options: AdapterOptions): string {
  const relativePath = relativeReportPath(path, options.reportRoot)
  return options.baseRenames?.get(relativePath) ?? relativePath
}

function messagesFor(raw: unknown, format: string, file: string): ReportMessage[] {
  const messages = (raw as { messages?: unknown })?.messages
  if (!Array.isArray(messages))
    throw new Error(`${format} report file ${file} has no messages array`)
  return messages
}

function captureGroupCount(source: string): number {
  let count = 0
  let escaped = false
  let inCharacterClass = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (character !== '(' || inCharacterClass) continue
    if (source[index + 1] !== '?') {
      count++
      continue
    }
    if (source[index + 2] === '<' && !['=', '!'].includes(source[index + 3] ?? '')) count++
  }
  return count
}

function compiledMeasures(patterns: MeasurePattern[]) {
  const measures = new Map<string, RegExp>()
  for (const { rule, pattern } of patterns) {
    let expression: RegExp
    try {
      expression = new RegExp(pattern)
    } catch (error) {
      throw new Error(
        `invalid measure pattern for rule ${rule}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (captureGroupCount(pattern) !== 1) {
      throw new Error(`measure pattern for rule ${rule} must have exactly one capture group`)
    }
    measures.set(rule, expression)
  }
  return measures
}

function measuredFinding(finding: Finding, measures: Map<string, RegExp>): Finding {
  const expression = measures.get(finding.rule)
  if (!expression) return finding
  const capture = expression.exec(finding.message)?.[1]
  const measure = capture?.trim() ? Number(capture) : Number.NaN
  if (!Number.isFinite(measure)) {
    throw new Error(
      `measure pattern for rule ${finding.rule} did not capture a number from message: ${finding.message}`,
    )
  }
  return { ...finding, measure }
}

function finding(
  file: string,
  raw: ReportMessage,
  rule: unknown,
  format: string,
  options: AdapterOptions,
  measures: Map<string, RegExp>,
): Finding {
  if (typeof raw.line !== 'number' || typeof rule !== 'string' || typeof raw.message !== 'string') {
    throw new Error(`${format} message in ${file} has no line, rule, or message`)
  }
  return measuredFinding(
    { file: normalizedPath(file, options), line: raw.line, rule, message: raw.message },
    measures,
  )
}

export function phpcsFindings(text: string, options: AdapterOptions): Finding[] {
  const measures = compiledMeasures(options.measures ?? [])
  return Object.entries(reportFiles(text, 'PHPCS')).flatMap(([file, raw]) =>
    messagesFor(raw, 'PHPCS', file).flatMap((message) =>
      message.type === 'ERROR'
        ? [finding(file, message, message.source, 'PHPCS', options, measures)]
        : [],
    ),
  )
}

export function phpstanFindings(text: string, options: AdapterOptions): Finding[] {
  const measures = compiledMeasures(options.measures ?? [])
  return Object.entries(reportFiles(text, 'PHPStan')).flatMap(([file, raw]) =>
    messagesFor(raw, 'PHPStan', file).map((message) =>
      finding(
        file,
        message,
        typeof message.identifier === 'string' ? message.identifier : PHPSTAN_UNIDENTIFIED_RULE,
        'PHPStan',
        options,
        measures,
      ),
    ),
  )
}
