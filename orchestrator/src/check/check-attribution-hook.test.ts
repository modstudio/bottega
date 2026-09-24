import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dir } from '../../test/preload.ts'

const sourceHook = resolve(import.meta.dir, '../../hooks/no-attribution.py')
const sourceMarkers = resolve(import.meta.dir, '../../../shared/attribution-markers.json')
const fixturePath = join(import.meta.dir, 'fixtures/attribution-cases.json')
const fixtureRunner = resolve(import.meta.dir, '../../test/no-attribution-fixture.py')

function layout(marker: 'valid' | 'absent' | 'unreadable' | 'malformed' = 'valid') {
  const root = mkdtempSync(join(dir, 'attribution-hook-'))
  const hook = join(root, 'orchestrator', 'hooks', 'no-attribution.py')
  const markerFile = join(root, 'shared', 'attribution-markers.json')
  mkdirSync(join(hook, '..'), { recursive: true })
  mkdirSync(join(markerFile, '..'), { recursive: true })
  copyFileSync(sourceHook, hook)
  chmodSync(hook, 0o755)
  if (marker === 'valid') copyFileSync(sourceMarkers, markerFile)
  else if (marker === 'unreadable') mkdirSync(markerFile)
  else if (marker === 'malformed') writeFileSync(markerFile, '{broken json')
  return { root, hook, markerFile }
}

function python(root: string, argv: string[], input?: string) {
  const inputPath = join(root, 'input.json')
  if (input !== undefined) writeFileSync(inputPath, input)
  return Bun.spawnSync(['python3', ...argv], {
    ...(input === undefined ? {} : { stdin: Bun.file(inputPath) }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function invoke(hook: string, root: string, command: string) {
  const result = python(
    root,
    [hook],
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
  )
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
  const output = result.stdout.toString().trim()
  return output ? JSON.parse(output) : null
}

function denialReason(output: unknown): string | undefined {
  return (output as { hookSpecificOutput?: { permissionDecisionReason?: string } } | null)
    ?.hookSpecificOutput?.permissionDecisionReason
}

describe('attribution hook', () => {
  test('uses the shared fixture for blocked and allowed attribution text', () => {
    const { root, hook } = layout()
    const result = python(root, [fixtureRunner, hook, fixturePath])
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: '',
    })
  })

  for (const state of ['absent', 'unreadable', 'malformed'] as const) {
    test(`denies when the marker file is ${state}`, () => {
      const { root, hook, markerFile } = layout(state)
      const reason = denialReason(invoke(hook, root, 'echo harmless'))
      expect(reason).toContain(markerFile)
      expect(reason).toContain('Cannot enforce AI attribution')
    })
  }

  for (const flag of ['-F', '--file', '--body-file', '--notes-file', '--message-file']) {
    test(`denies an unreadable ${flag} path`, () => {
      const { root, hook } = layout()
      const path = `missing-${flag.replaceAll('-', '')}`
      const reason = denialReason(invoke(hook, root, `git commit ${flag} ${path}`))
      expect(reason).toContain(path)
      expect(reason).toContain('Cannot inspect message file')
    })
  }
})
