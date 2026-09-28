import { expect, test } from 'bun:test'
import { assertUserCanonHydrateAllowed } from './docs.ts'

const flags = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

test('an orch worker cannot hydrate user canon but can check it', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      { pid: 300, ppid: 200, pgid: 100, command: 'orch canon hydrate --user' },
    ],
  }

  expect(() => assertUserCanonHydrateAllowed(flags(), {}, 300, inventory)).toThrow(
    'refusing user canon hydrate from an orch worker run; an operator must run orch canon hydrate --user',
  )
  expect(() => assertUserCanonHydrateAllowed(flags('check'), {}, 300, inventory)).not.toThrow()
})
