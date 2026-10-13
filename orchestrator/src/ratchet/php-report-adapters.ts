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

function parsedReport(text: string, format: string): { files?: unknown; errors?: unknown } {
  try {
    return JSON.parse(text) as { files?: unknown; errors?: unknown }
  } catch (error) {
    throw new Error(
      `invalid ${format} JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// PHP encodes an empty map as an empty array, so a clean report carries `"files": []`.
function reportFiles(files: unknown, format: string): Record<string, unknown> {
  if (Array.isArray(files) && files.length === 0) return {}
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

function messagesFor(raw: unknown, format: string, file: string): ReportMessage[] {
  const messages = (raw as { messages?: unknown })?.messages
  if (!Array.isArray(messages))
    throw new Error(`${format} report file ${file} has no messages array`)
  return messages
}

function captureGroupCount(pattern: string): number {
  return new RegExp(`${pattern}|`).exec('')!.length - 1
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
  const files = reportFiles(parsedReport(text, 'PHPCS').files, 'PHPCS')
  return Object.entries(files).flatMap(([file, raw]) =>
    messagesFor(raw, 'PHPCS', file).flatMap((message) =>
      message.type === 'ERROR'
        ? [finding(file, message, message.source, 'PHPCS', options, measures)]
        : [],
    ),
  )
}

export function phpstanFindings(text: string, options: AdapterOptions): Finding[] {
  const measures = compiledMeasures(options.measures ?? [])
  const report = parsedReport(text, 'PHPStan')
  // Errors that belong to no file mean the analysis itself failed; its findings cannot be trusted.
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error(`PHPStan reported an analysis error: ${String(report.errors[0])}`)
  }
  return Object.entries(reportFiles(report.files, 'PHPStan')).flatMap(([file, raw]) =>
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
