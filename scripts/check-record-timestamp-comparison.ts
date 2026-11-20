#!/usr/bin/env bun
import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import {
  RECORD_TIMESTAMP_COMPARISON_REMEDY,
  RECORD_TIMESTAMP_COMPARISON_SELECTORS,
  RECORD_TIMESTAMP_GUARD_SCOPE,
} from '../hub/src/record-timestamp-guard.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
type EslintResults = Awaited<ReturnType<ESLint['lintText']>>

function recordTimestampMessages(results: EslintResults) {
  return results.flatMap((result) =>
    result.messages
      .filter(
        (message) =>
          message.ruleId === 'no-restricted-syntax' &&
          message.message === RECORD_TIMESTAMP_COMPARISON_REMEDY,
      )
      .map((message) => ({
        filePath: result.filePath,
        line: message.line,
        message: message.message,
      })),
  )
}

export function selectRecordTimestampGuardFiles(paths: readonly string[]): string[] {
  const fileGlobs = RECORD_TIMESTAMP_GUARD_SCOPE.files.map((pattern) => new Bun.Glob(pattern))
  const ignoreGlobs = RECORD_TIMESTAMP_GUARD_SCOPE.ignores.map((pattern) => new Bun.Glob(pattern))
  const selected = paths.filter(
    (path) =>
      fileGlobs.some((glob) => glob.match(path)) && !ignoreGlobs.some((glob) => glob.match(path)),
  )
  if (selected.length === 0) {
    throw new Error(
      `No files matched record timestamp guard scope ${RECORD_TIMESTAMP_GUARD_SCOPE.files.join(', ')} excluding ${RECORD_TIMESTAMP_GUARD_SCOPE.ignores.join(', ')}`,
    )
  }
  return selected
}

async function checkRecordTimestampComparisons() {
  const files = selectRecordTimestampGuardFiles(
    readdirSync(resolve(ROOT, 'hub/src')).map((file) => `hub/src/${file}`),
  ).map((file) => resolve(ROOT, file))
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: {
      rules: { 'no-restricted-syntax': ['error', ...RECORD_TIMESTAMP_COMPARISON_SELECTORS] },
    },
  })
  const findings = recordTimestampMessages(await eslint.lintFiles(files))
  for (const finding of findings) {
    console.error(`${relative(ROOT, finding.filePath)}:${finding.line}: ${finding.message}`)
  }
  if (findings.length) return false
  console.log(`check-record-timestamp-comparison: ok (${files.length} files)`)
  return true
}

if (import.meta.main && !(await checkRecordTimestampComparisons())) process.exit(1)
