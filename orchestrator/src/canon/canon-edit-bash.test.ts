import { describe, expect, test } from 'bun:test'
import { BASH_WRITE_ESCAPES, bashWriteTargets } from './canon-edit-bash.ts'
import { decideCanonEdit, type EnforcedContext } from './canon-edit-guard.ts'

const context: EnforcedContext = {
  path: '.agents/contexts/guarded.md',
  description: 'Guarded directory',
  globs: ['dir/**'],
}
const decide = (command: string) =>
  decideCanonEdit({
    managedContext: true,
    tool: 'Bash',
    toolInput: { command },
    cwd: '/repo',
    repoRoot: '/repo',
    contexts: [context],
    events: [],
  })

describe('Bash write target extraction', () => {
  test.each([
    ['redirect', 'printf x > dir/a.ts'],
    ['append fd redirect', 'printf x 2>> dir/a.ts'],
    ['tee', 'printf x | tee dir/a.ts'],
    ['sed in place', "sed -i '' -e 's/x/y/' dir/a.ts"],
    ['cp destination', 'cp source.ts dir/a.ts'],
    ['mv destination', 'mv source.ts dir/a.ts'],
  ])('%s is guarded', (_name, command) => expect(decide(command).allow).toBe(false))

  test.each([
    ['cp trailing directory', 'cp x dir/'],
    ['mv directory', 'mv x dir'],
    ['install target directory', 'install -t dir x'],
    ['cp target directory', 'cp -t dir x'],
    ['tee trailing directory', 'tee dir/'],
    ['redirect trailing directory', '> dir/'],
  ])('%s is guarded by dir/**', (_name, command) => expect(decide(command).allow).toBe(false))

  test('a read-only command allows', () => expect(decide('git status')).toEqual({ allow: true }))

  test('the exported unresolved escape list corresponds to allowed command shapes', () => {
    expect(BASH_WRITE_ESCAPES).toEqual([
      'relative targets after cd',
      'command substitutions',
      'interpreter writes',
      'git apply',
      'patch',
    ])
    for (const command of [
      'cd dir && printf x > a.ts',
      'printf x > "$(printf dir/a.ts)"',
      "python3 -c \"open('dir/a.ts', 'w').write('x')\"",
      'git apply change.patch',
      'patch -p1 < change.patch',
    ])
      expect(decide(command)).toEqual({ allow: true })
  })

  test('quoted text, heredoc bodies, and separators do not create false redirects', () => {
    expect(bashWriteTargets("git commit -m 'a -> dir/a.ts'")).toEqual([])
    expect(bashWriteTargets("cat <<'EOF'\n> dir/a.ts\nEOF")).toEqual([])
    expect(bashWriteTargets('true && printf x > dir/a.ts')).toEqual(['dir/a.ts'])
  })
})
