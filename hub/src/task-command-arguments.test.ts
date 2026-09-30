import { describe, expect, test } from 'bun:test'
import { parseTaskArguments, resolveTaskCommand } from './task-command-arguments.ts'

function parse(command: string, argv: string[]) {
  const commandArgv = [...command.split(' '), ...argv]
  const resolved = resolveTaskCommand(commandArgv)
  if (!resolved) throw new Error(`missing test shape for ${command}`)
  return parseTaskArguments(commandArgv, resolved)!
}

describe('task command arguments', () => {
  test('refuses a flag-looking comment body', () => {
    const result = parse('comment', ['DEV-847', '--file', 'body.md'])
    expect(result).toEqual({
      ok: false,
      refusal:
        'positional cannot start with --: --file\nvalid syntax: hub task comment <KEY> "..." [--project X]',
    })
  })

  test('refuses an unknown document flag and names it', () => {
    const result = parse('doc new', ['DEV-847', '--title', 'X', '--file', 'body.md'])
    expect(result.ok).toBeFalse()
    if (!result.ok) expect(result.refusal).toContain('--file')
  })

  test('accepts a document body file', () => {
    expect(parse('doc new', ['DEV-847', '--title', 'X', '--body-file', 'body.md']).ok).toBeTrue()
  })

  test('accepts setting a task status', () => {
    expect(parse('set', ['DEV-847', '--status', 'done']).ok).toBeTrue()
  })

  test('accepts keeping branches while closing', () => {
    expect(parse('close', ['DEV-847', '--keep-branches']).ok).toBeTrue()
  })

  test('requires a reason when forcing a close', () => {
    expect(parse('close', ['DEV-847', '--abandon', 'prototype abandoned']).ok).toBeTrue()
    expect(parse('close', ['DEV-847', '--abandon']).ok).toBeFalse()
    expect(parse('set', ['DEV-847', '--status', 'done', '--abandon', 'prototype abandoned']).ok).toBeTrue()
    expect(parse('set', ['DEV-847', '--status', 'done', '--abandon']).ok).toBeFalse()
  })

  test('refuses a value flag with no value', () => {
    expect(parse('doc new', ['DEV-847', '--title'])).toEqual({
      ok: false,
      refusal:
        'value flag has no value: --title\nvalid syntax: hub task doc new <KEY> [--project X] --title "..." [--role handoff] [--body "..."|--body-file PATH]',
    })
  })

  test('refuses too few or too many positionals', () => {
    expect(parse('show', []).ok).toBeFalse()
    expect(parse('show', ['DEV-847', 'extra']).ok).toBeFalse()
  })

  test('resolves document as an alias of doc', () => {
    const resolved = resolveTaskCommand(['document', 'show', '42'])
    expect(resolved?.command).toBe('doc show')
    expect(resolved?.remaining).toEqual(['42'])
  })
})
