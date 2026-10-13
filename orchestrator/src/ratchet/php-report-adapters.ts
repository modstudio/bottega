import { isAbsolute, relative, resolve } from 'node:path'
import type { Finding } from '../../../shared/ratchet.ts'

const PHPSTAN_UNIDENTIFIED_RULE = 'phpstan'

export type MeasurePattern = { rule: string; pattern: string }

type AdapterOptions = {
  reportRoot: string
  measures?: MeasurePattern[]
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
  if (typeof files !== 'object' || files === null) {
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

function messagesFor(raw: unknown, format: string, file: string): ReportMessage[] {
  const messages = (raw as { messages?: unknown })?.messages
  if (!Array.isArray(messages))
    throw new Error(`${format} report file ${file} has no messages array`)
  return messages
}

type PatternScan = { count: number; escaped: boolean; inCharacterClass: boolean }

function scanPatternCharacter(source: string, index: number, state: PatternScan): PatternScan {
  const character = source[index]
  if (state.escaped) return { ...state, escaped: false }
  if (character === '\\') return { ...state, escaped: true }
  if (character === '[') return { ...state, inCharacterClass: true }
  if (character === ']' && state.inCharacterClass) return { ...state, inCharacterClass: false }
  if (character !== '(' || state.inCharacterClass) return state
  const plainCapture = source[index + 1] !== '?'
  const namedCapture = source[index + 2] === '<' && !['=', '!'].includes(source[index + 3] ?? '')
  return plainCapture || namedCapture ? { ...state, count: state.count + 1 } : state
}

function captureGroupCount(source: string): number {
  let state: PatternScan = { count: 0, escaped: false, inCharacterClass: false }
  for (let index = 0; index < source.length; index++) {
    state = scanPatternCharacter(source, index, state)
  }
  return state.count
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
  const line = raw.line == null ? 0 : raw.line
  if (typeof line !== 'number' || typeof rule !== 'string' || typeof raw.message !== 'string') {
    throw new Error(`${format} message in ${file} has no line, rule, or message`)
  }
  return measuredFinding(
    { file: relativeReportPath(file, options.reportRoot), line, rule, message: raw.message },
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
