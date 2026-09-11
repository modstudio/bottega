import { describe, expect, test } from 'bun:test'
import { errorTail, verifiedProcessTree } from './run-process.ts'

describe('what survives of a failure', () => {
  const codexish = (promptChars: number) =>
    'OpenAI Codex v0.151.0\n--------\nmodel: gpt-5.6-sol\nsandbox: read-only\n--------\n' +
    'x'.repeat(promptChars) +
    '\nERROR: the thing that actually broke'

  test('the error at the end is kept', () => {
    expect(errorTail(codexish(50_000))).toContain('the thing that actually broke')
  })

  test('and the banner at the start is kept too', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('OpenAI Codex v0.151.0')
    expect(out).toContain('model: gpt-5.6-sol')
  })

  test('the echoed prompt in the middle is what gets dropped', () => {
    const out = errorTail(codexish(50_000))
    expect(out).toContain('characters omitted')
    expect(out.length).toBeLessThan(2200)
  })

  test('a short error is stored whole, untouched', () => {
    expect(errorTail('exit 143, empty output')).toBe('exit 143, empty output')
  })
})

test('process reaping selects the whole verified tree youngest-first and rejects pid reuse', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, command: 'bun /repo/orchestrator/src/exec.ts 44 prompt implement' },
    { pid: 11, ppid: 10, pgid: 10, command: 'vendor' },
    { pid: 12, ppid: 11, pgid: 10, command: 'gateway' },
    { pid: 99, ppid: 1, pgid: 99, command: 'bun run dev' },
  ]
  expect(verifiedProcessTree(rows, 44, 10)).toEqual([12, 11, 10])
  expect(verifiedProcessTree(rows, 44, 99)).toEqual([])
  expect(verifiedProcessTree(rows, 45, 10)).toEqual([])
})
