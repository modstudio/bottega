// concern: prose
/** I/O adapter for the lazily initialized Harper prose engine. */

import { readFileSync } from 'node:fs'
import { Dialect, type LintConfig, LocalLinter } from 'harper.js'
import { binary } from 'harper.js/binary'

export type EngineFinding = {
  rule: string
  start: number
  end: number
  text: string
  message: string
  suggestions: string[]
}

export type EngineResult = { ran: true; findings: EngineFinding[] } | { ran: false; reason: string }

let linterPromise: Promise<LocalLinter> | null = null

function dictionaryWords(): string[] {
  return readFileSync(new URL('./dictionary.txt', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter((word) => word !== '' && !word.startsWith('#'))
}

function recordRules(): LintConfig {
  return JSON.parse(
    readFileSync(new URL('./record-rules.json', import.meta.url), 'utf8'),
  ) as LintConfig
}

async function initializedLinter(): Promise<LocalLinter> {
  if (linterPromise === null) {
    linterPromise = (async () => {
      const linter = new LocalLinter({ binary, dialect: Dialect.American })
      await linter.setup()
      await linter.importWords(dictionaryWords())
      await linter.setLintConfig(recordRules())
      return linter
    })()
  }
  return linterPromise
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function harperFindings(text: string): Promise<EngineResult> {
  try {
    const linter = await initializedLinter()
    const organized = await linter.organizedLints(text, { language: 'markdown' })
    const entries = Object.entries(organized).flatMap(([rule, lints]) =>
      lints.map((lint) => ({ rule, lint })),
    )
    try {
      const findings: EngineFinding[] = []
      for (const { rule, lint } of entries) {
        const span = lint.span()
        let suggestions: ReturnType<typeof lint.suggestions> = []
        try {
          suggestions = lint.suggestions()
          findings.push({
            rule,
            start: span.start,
            end: span.end,
            text: lint.get_problem_text(),
            message: lint.message(),
            suggestions: suggestions.map((suggestion) => suggestion.get_replacement_text()),
          })
        } finally {
          span.free()
          for (const suggestion of suggestions) suggestion.free()
        }
      }
      return { ran: true, findings }
    } finally {
      for (const { lint } of entries) lint.free()
    }
  } catch (error) {
    return { ran: false, reason: errorMessage(error) }
  }
}
