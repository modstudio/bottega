import { describe, expect, test } from 'bun:test'
import { validateCliArgs } from './args.ts'

describe('CLI argument recognition', () => {
  test('every command with legitimate positionals still accepts its documented shape', () => {
    const commands = [
      ['land', 'feature/DEV-185'], ['land', '--status'], ['contract', 'implement'],
      ['doc', 'show', 'slug', '--scope', 'global'],
      ['doc', 'set', 'slug', '--scope', 'global', '--title', 'Title', '--file', 'body.md'],
      ['doc', 'consume', 'slug', '--scope', 'global'],
      ['doc', 'rm', 'slug', '--scope', 'global'], ['doc', 'export', 'docs'],
      ['doc', 'import', 'docs'], ['do', 'summarize', 'a', 'multi-word', 'prompt'],
      ['run', '12'], ['result', '12', '--quiet'],
      ['wait', '12', '13', '--timeout', '30'], ['retry', '12', '--agent', 'codex'],
      ['project', 'add', '/tmp/project', '--name', 'project'],
      ['project', 'set', 'project', '--settings', '{"gate":"bun run check"}'],
      ['project', 'remove', 'project'],
      ['answer', '12', 'first ruling', 'second ruling'],
      ['answer', '12', '--q31', 'first ruling', '--q32', 'second ruling'],
      ['continue', '12', 'one more change'], ['diff', '12', '--quiet'], ['discard', '12', '--force'],
      ['stop', '12'], ['abandon', '12', '--note', 'superseded'],
      ['score', '12', 'full', 'right', 'faithful', '--note', 'good'],
      ['pick', 'implement', '--distinct-from', '10,11'], ['metric', 'collect', '--days', '30'],
    ]
    for (const argv of commands) expect(() => validateCliArgs(argv)).not.toThrow()
  })

  test('a stray positional is named with the working form', () => {
    expect(() => validateCliArgs(['project', 'set', 'registered', 'gate', 'bun run check']))
      .toThrow('unrecognised argument: gate\nworking form: orch project set <name>')
  })

  test('an unknown flag is named with the working form', () => {
    expect(() => validateCliArgs(['runs', '--jobs', 'implement']))
      .toThrow('unrecognised argument: --jobs\nworking form: orch runs')
  })

  test('a value flag without its value is refused before execution', () => {
    expect(() => validateCliArgs(['project', 'set', 'registered', '--settings']))
      .toThrow('argument --settings needs a value\nworking form: orch project set <name>')
  })
})
