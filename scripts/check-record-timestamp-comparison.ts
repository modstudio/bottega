#!/usr/bin/env bun
import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REMEDY = 'Compare record timestamps with sameRecordInstant from shared/record-timestamp.ts.'
type EslintResults = Awaited<ReturnType<ESLint['lintText']>>

export function recordTimestampMessages(results: EslintResults) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === 'no-restricted-syntax' && message.message === REMEDY)
      .map((message) => ({
        filePath: result.filePath,
        line: message.line,
        message: message.message,
      })),
  )
}

export async function lintRecordTimestampSource(source: string, filename: string) {
  const eslint = new ESLint({ cwd: ROOT })
  return recordTimestampMessages(
    await eslint.lintText(source, { filePath: resolve(ROOT, 'hub/src', filename) }),
  )
}

async function checkRecordTimestampComparisons() {
  const files = readdirSync(resolve(ROOT, 'hub/src'))
    .filter(
      (file) =>
        file.startsWith('hosted-push-') && file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )
    .map((file) => resolve(ROOT, 'hub/src', file))
  const findings = recordTimestampMessages(await new ESLint({ cwd: ROOT }).lintFiles(files))
  for (const finding of findings) {
    console.error(`${relative(ROOT, finding.filePath)}:${finding.line}: ${finding.message}`)
  }
  if (findings.length) return false
  console.log(`check-record-timestamp-comparison: ok (${files.length} files)`)
  return true
}

if (import.meta.main && !(await checkRecordTimestampComparisons())) process.exit(1)
