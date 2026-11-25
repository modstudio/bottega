import { expect, test } from 'bun:test'
import { destructiveTestGuardFindings } from './check-destructive-test-guards.ts'

test('flags environment-gated early returns in supported line shapes', () => {
  const findings = destructiveTestGuardFindings({
    'shared/test-guard.ts': [
      "if (process.env.NODE_ENV !== 'test') return",
      'if (!process.env.SAFE_STORE) return',
      "if (process.env.NODE_ENV !== 'test') { return }",
      "if (process.env['NODE_ENV'] !== 'test') return",
      "if (Bun.env.NODE_ENV !== 'test') return",
    ].join('\n'),
  })

  expect(findings).toEqual([
    { file: 'shared/test-guard.ts', line: 1 },
    { file: 'shared/test-guard.ts', line: 2 },
    { file: 'shared/test-guard.ts', line: 3 },
    { file: 'shared/test-guard.ts', line: 4 },
    { file: 'shared/test-guard.ts', line: 5 },
  ])
})

test('does not flag an early return gated on a non-environment condition', () => {
  expect(
    destructiveTestGuardFindings({
      'orchestrator/test/fixtures/guard.ts': 'if (!storeWasMinted) return',
    }),
  ).toEqual([])
})
