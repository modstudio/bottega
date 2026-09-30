import { describe, expect, test } from 'bun:test'
import { parseTaskArguments, taskCommandShapes } from './task-command-arguments.ts'

function parse(command: string, argv: string[]) {
  const commandShape = taskCommandShapes.get(command)
  if (!commandShape) throw new Error(`missing test shape for ${command}`)
  return parseTaskArguments(argv, commandShape)
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
})
