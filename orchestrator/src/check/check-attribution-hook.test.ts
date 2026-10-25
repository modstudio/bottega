import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { dir } from '../../test/preload.ts'

const sourceHook = resolve(import.meta.dir, '../../hooks/no-attribution.py')
const sourceMarkers = resolve(import.meta.dir, '../../../shared/attribution-markers.json')
const fixturePath = join(import.meta.dir, 'fixtures/attribution-cases.json')
const fixtureRunner = resolve(import.meta.dir, '../../test/no-attribution-fixture.py')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { blocked: string[] }
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function layout(marker: 'valid' | 'absent' | 'unreadable' | 'malformed' = 'valid') {
  const root = mkdtempSync(join(dir, 'attribution-hook-'))
  fixtureRoots.push(root)
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
    test(`allows non-writes and denies writes when the marker file is ${state}`, () => {
      const { root, hook, markerFile } = layout(state)
      expect(invoke(hook, root, 'ls')).toBeNull()
      const reason = denialReason(invoke(hook, root, 'git commit -m x'))
      expect(reason).toContain(markerFile)
      expect(reason).toContain('Cannot enforce AI attribution')
    })
  }

  test('allows a write with an unreadable message-file path and warns', () => {
    const { root, hook } = layout()
    const path = 'missing-message'
    const output = invoke(hook, root, `git commit --message-file ${path}`) as {
      hookSpecificOutput?: { permissionDecision?: string }
      systemMessage?: string
    }
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined()
    expect(output.systemMessage).toContain(path)
  })

  test('denies a write when its readable message file contains blocked attribution', () => {
    const { root, hook } = layout()
    const path = join(root, 'message.txt')
    const blockedAttribution = fixture.blocked[0]
    if (!blockedAttribution) throw new Error('shared fixture has no blocked attribution text')
    writeFileSync(path, blockedAttribution)
    const reason = denialReason(invoke(hook, root, `git commit --message-file ${path}`))
    expect(reason).toContain('AI attribution is not allowed')
  })
})
