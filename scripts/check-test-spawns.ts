#!/usr/bin/env bun
/**
 * Two static test rules: files under the static roots spawn nothing, build no
 * repository and touch no live store; and no tracked or unignored test file
 * adds a process-global mock.module call. The latter's named baseline may only
 * shrink. This runs with `bun run check` and reads no gate timing artifact. The
 * measured spawn half lives in scripts/check-test-spawns-measured.ts and runs
 * against the artifact of the one gate run that produced it, from
 * orchestrator/test/run-gate.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gitAt } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'
import { mockModuleViolations } from './quality/test-spawns-decision.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const STATIC_TEST_ROOTS = ['.githooks', 'hub', 'scripts', 'shared']

const MOCK_MODULE_BASELINE = {
  'hub/src/trpc/router.test.ts': 'partial hub/src/orch.ts stub; replace in a separate task',
  'shared/bounded-process.test.ts': 'partial execa stub; replace in a separate task',
} as const

type StaticViolation = { file: string; line: number; reason: string }

function isTestFilePath(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path)
}

function testFilesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isTestFilePath(entry.name))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .filter((file) => !file.includes('/node_modules/'))
}

function repositoryTestFiles(): string[] {
  const listed = gitAt(
    ROOT,
    nulPathListArgs(['ls-files', '--cached', '--others', '--exclude-standard']),
  )
  if (listed.code !== 0) {
    throw new Error(
      renderRefusal(
        refusal(`could not list repository test files: ${listed.stderr.trim()}`, {
          kind: 'edit',
          text: 'Restore git access, then rerun bun scripts/check-test-spawns.ts',
        }),
      ),
    )
  }
  return splitNulPaths(listed.stdout).filter(isTestFilePath)
}

function repositoryMockModuleViolations(): StaticViolation[] {
  const callsByFile = new Map<string, number[]>()
  for (const file of repositoryTestFiles()) {
    const calls = readFileSync(`${ROOT}/${file}`, 'utf8')
      .split('\n')
      .flatMap((line, index) => (/\bmock\.module\s*\(/.test(line) ? [index + 1] : []))
    if (calls.length > 0) callsByFile.set(file, calls)
  }

  return mockModuleViolations({ callsByFile, baseline: MOCK_MODULE_BASELINE })
}

function staticViolations(): StaticViolation[] {
  const files = STATIC_TEST_ROOTS.flatMap((path) => testFilesUnder(`${ROOT}/${path}`))
  return files.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split('\n')
    const mainCheckoutBindings = lines.flatMap((line) => {
      const match = line.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*mainCheckoutOf\s*\(/)
      return match?.[1] ? [match[1]] : []
    })
    return lines.flatMap((line, index) => {
      let reason: string | null = null
      if (/\bBun\.spawnSync\s*\(/.test(line)) reason = 'real Bun.spawnSync call'
      else if (/\bBun\.spawn\s*\(/.test(line)) reason = 'real Bun.spawn call'
      else if (/\bexeca\s*\(/.test(line)) reason = 'real execa call'
      else if (/\b(?:from|require\s*\()\s*['"](?:node:)?child_process['"]/.test(line)) {
        reason = 'child_process import'
      } else if (/\bcopyLiveHub\b/.test(line)) reason = 'live hub store access'
      else if (
        /\b(?:hub|orch)\.db\b/.test(line) &&
        mainCheckoutBindings.some((binding) => line.includes(`join(${binding}`))
      ) {
        reason = 'live store joined from mainCheckoutOf'
      }
      return reason ? [{ file: file.slice(ROOT.length + 1), line: index + 1, reason }] : []
    })
  })
}

const staticFailures = [...staticViolations(), ...repositoryMockModuleViolations()]
for (const violation of staticFailures) {
  console.error(`${violation.file}:${violation.line}: ${violation.reason}`)
}
if (staticFailures.length) process.exit(1)
console.log('check-test-spawns: static rule ok')
