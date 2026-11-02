// concern: prose
/** I/O adapter for the lazily initialized Harper prose engine. */

import { Dialect, type LintConfig, LocalLinter, SuggestionKind } from 'harper.js'
import { binary } from 'harper.js/binary'
import dictionaryText from './dictionary.txt' with { type: 'text' }
import recordRules from './record-rules.json' with { type: 'json' }

export type EngineFinding = {
  rule: string
  start: number
  end: number
  text: string
  message: string
  suggestions: Array<{ kind: 'replace' | 'remove' | 'insert-after'; text: string }>
}

export type EngineResult = { ran: true; findings: EngineFinding[] } | { ran: false; reason: string }

const HARPER_MAX_WORD_CHARS = 64

let linterPromise: Promise<LocalLinter> | null = null

function dictionaryWords(): string[] {
  const words = dictionaryText
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter((word) => word !== '' && !word.startsWith('#'))
  return [
    ...new Set(
      words.flatMap((word) => {
        const lowercase = word.toLowerCase()
        return [word, lowercase, `${word}'s`, `${word}’s`, `${lowercase}'s`, `${lowercase}’s`]
      }),
    ),
  ]
}

function normalizedDictionaryWords(): Set<string> {
  return new Set(dictionaryWords().map((word) => word.replaceAll('’', "'")))
}

function suggestionKind(kind: SuggestionKind): EngineFinding['suggestions'][number]['kind'] {
  if (kind === SuggestionKind.Remove) return 'remove'
  if (kind === SuggestionKind.InsertAfter) return 'insert-after'
  return 'replace'
}

async function initializedLinter(): Promise<LocalLinter> {
  if (linterPromise === null) {
    linterPromise = (async () => {
      const linter = new LocalLinter({ binary, dialect: Dialect.American })
      await linter.setup()
      await linter.importWords(dictionaryWords())
      const defaultRules = await linter.getDefaultLintConfig()
      const disabledRules = Object.fromEntries(
        Object.keys(defaultRules).map((rule) => [rule, false]),
      ) as LintConfig
      await linter.setLintConfig({ ...disabledRules, ...(recordRules as LintConfig) })
      return linter
    })()
  }
  return linterPromise
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function maskOverlongWords(text: string): string {
  return text.replace(/\S+/g, (word) =>
    word.length > HARPER_MAX_WORD_CHARS ? ' '.repeat(word.length) : word,
  )
}

async function runHarperFindings(text: string): Promise<EngineResult> {
  try {
    const linter = await initializedLinter()
    const organized = await linter.organizedLints(maskOverlongWords(text), { language: 'markdown' })
    const entries = Object.entries(organized).flatMap(([rule, lints]) =>
      lints.map((lint) => ({ rule, lint })),
    )
    try {
      const findings: EngineFinding[] = []
      const dictionary = normalizedDictionaryWords()
      for (const { rule, lint } of entries) {
        const span = lint.span()
        let suggestions: ReturnType<typeof lint.suggestions> = []
        try {
          const problemText = lint.get_problem_text()
          // Harper 2.13.0 does not apply imported possessive words.
          if (rule === 'SpellCheck' && dictionary.has(problemText.replaceAll('’', "'"))) continue
          suggestions = lint.suggestions()
          findings.push({
            rule,
            start: span.start,
            end: span.end,
            text: problemText,
            message: lint.message(),
            suggestions: suggestions.map((suggestion) => ({
              kind: suggestionKind(suggestion.kind()),
              text: suggestion.get_replacement_text(),
            })),
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
    linterPromise = null
    return { ran: false, reason: errorMessage(error) }
  }
}

let lintTail: Promise<void> = Promise.resolve()

export function harperFindings(text: string): Promise<EngineResult> {
  const result = lintTail.then(() => runHarperFindings(text))
  lintTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
