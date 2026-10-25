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
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  blocked: string[]
}
const fixtureRoots: string[] = []
type HookOutput = {
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
  systemMessage?: string
}

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

function invokeMany(
  hook: string,
  root: string,
  payloads: Array<{ command: string; cwd?: unknown }>,
  env?: Record<string, string>,
): Array<HookOutput | null> {
  const runner = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("no_attribution", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
results = []
stdout = sys.stdout
for payload in json.load(sys.stdin):
    sys.stdin = io.StringIO(json.dumps(payload))
    sys.stdout = io.StringIO()
    module.main()
    output = sys.stdout.getvalue()
    results.append(json.loads(output) if output else None)
sys.stdout = stdout
json.dump(results, sys.stdout)
`
  const inputs = payloads.map(({ command, cwd = root }) => ({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  }))
  const result = Bun.spawnSync(['python3', '-c', runner, hook], {
    env: { ...process.env, ...env },
    stdin: Buffer.from(JSON.stringify(inputs)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toEqual({
    exitCode: 0,
    stderr: '',
  })
  return JSON.parse(result.stdout.toString()) as Array<HookOutput | null>
}

function invoke(hook: string, root: string, command: string): HookOutput | null {
  return invokeMany(hook, root, [{ command }])[0] ?? null
}

function denialReason(output: HookOutput | null): string | undefined {
  return output?.hookSpecificOutput?.permissionDecisionReason
}

describe('attribution hook', () => {
  test('uses the shared fixture for blocked and allowed attribution text', () => {
    const { root, hook } = layout()
    const result = python(root, [fixtureRunner, hook, fixturePath])
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
    }).toEqual({
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

  test('recognizes every message-file flag and preserves check order', () => {
    const { root, hook } = layout()
    const blockedAttribution = fixture.blocked[0]
    if (!blockedAttribution) throw new Error('shared fixture has no blocked attribution text')
    const blockedPath = join(root, 'blocked-message.txt')
    writeFileSync(blockedPath, blockedAttribution)
    const flags = ['-F', '--file', '--body-file', '--notes-file', '--message-file']
    const missingPaths = flags.map((_, index) => `missing-message-${index}`)
    const outputs = invokeMany(hook, root, [
      ...flags.map((flag, index) => ({
        command: `git commit ${flag} ${missingPaths[index]}`,
      })),
      {
        command: `git commit -m ${JSON.stringify(blockedAttribution)} --message-file missing-command-blocked`,
      },
      {
        command: `git commit --message-file missing-before-readable --message-file ${blockedPath}`,
      },
    ])

    for (const [index, path] of missingPaths.entries()) {
      expect(outputs[index]?.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(outputs[index]?.systemMessage).toContain(path)
    }
    expect(denialReason(outputs.at(-2) ?? null)).toContain('AI attribution is not allowed')
    expect(outputs.at(-2)?.systemMessage).toBeUndefined()
    expect(denialReason(outputs.at(-1) ?? null)).toContain('AI attribution is not allowed')
  })

  test('does not expand environment variables into unreadable-path warnings', () => {
    const { root, hook } = layout()
    const variable = 'DEV1619_PROBE'
    const value = 'probe-value-not-a-secret'
    const output = invokeMany(hook, root, [{ command: `git commit --message-file $${variable}` }], {
      [variable]: value,
    })[0]
    expect(output?.systemMessage).toContain(`$${variable}`)
    expect(output?.systemMessage).not.toContain(value)
  })

  test('allows NUL paths and non-string cwd values with a warning', () => {
    const { root, hook } = layout()
    const nulPath = 'message\0file'
    const outputs = invokeMany(hook, root, [
      { command: `git commit --message-file ${nulPath}` },
      {
        command: 'git commit --message-file missing-from-numeric-cwd',
        cwd: 1619,
      },
    ])
    expect(outputs[0]?.systemMessage).toContain(nulPath)
    expect(outputs[0]?.systemMessage).toContain('ValueError')
    expect(outputs[1]?.systemMessage).toContain('missing-from-numeric-cwd')
  })
})
