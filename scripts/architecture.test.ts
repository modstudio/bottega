import { expect, test } from 'bun:test'
import { architectureRules, exactArchitecturePath, inversions, modules } from './architecture.ts'

test('every module emits its exact allowlist as a forbidden rule', () => {
  const { forbidden } = architectureRules()
  for (const entry of modules) {
    const rule = forbidden.find(
      (candidate) => candidate.from.path === exactArchitecturePath(entry.file),
    )
    expect(rule?.to.pathNot).toEqual(entry.allowed.map(exactArchitecturePath))
  }
})

test('every inversion pair emits a forbidden rule', () => {
  const { forbidden } = architectureRules()
  for (const inversion of inversions) {
    expect(
      forbidden.some(
        (rule) =>
          rule.from.path === exactArchitecturePath(inversion.from) &&
          rule.to.path === exactArchitecturePath(inversion.to),
      ),
    ).toBe(true)
  }
})

test('hosted report delivery transitively rejects the local store and git', () => {
  const rule = architectureRules().forbidden.find(
    (candidate) =>
      candidate.name === 'import-hosted-report-delivery-no-local-store-transitive-boundary',
  )
  expect(rule).toBeDefined()
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery.ts'))
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery-hosted.ts'))
  expect(rule?.from.path).toContain(exactArchitecturePath('hub/src/report-delivery-cli.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('hub/src/db.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('shared/git.ts'))
  expect(rule?.to.path).toContain(exactArchitecturePath('bun:sqlite'))
  expect(rule?.to.reachable).toBe(true)
})

function ruleAllows(
  rule: ReturnType<typeof architectureRules>['forbidden'][number],
  from: string,
  to: string,
): boolean {
  if (!new RegExp(rule.from.path).test(from)) return true
  if (rule.from.pathNot?.some((pattern) => new RegExp(pattern).test(from))) return true
  if (rule.to.path && !new RegExp(rule.to.path).test(to)) return true
  return Boolean(rule.to.pathNot?.some((pattern) => new RegExp(pattern).test(to)))
}

test('only the cli composition root receives concern entry exceptions', () => {
  const rules = architectureRules().forbidden
  const isolation = rules.find((rule) => rule.name === 'concern-isolation')!
  const composition = rules.find((rule) => rule.name === 'cli-imports-only-concern-entries')!
  const inspection = rules.find(
    (rule) => rule.name === 'cli-route-test-inspects-only-owner-programs',
  )!
  const compositionRoot = modules.find((entry) => entry.allowed.includes('hub/src/cli.ts'))!.file
  expect(
    ruleAllows(isolation, 'hub/src/architecture-hole-proof.ts', 'orchestrator/src/cli/orch.ts'),
  ).toBeFalse()
  expect(ruleAllows(composition, compositionRoot, 'orchestrator/src/cli/orch.ts')).toBeTrue()
  expect(ruleAllows(inspection, 'cli/routes.test.ts', 'orchestrator/src/cli/program.ts')).toBeTrue()
  expect(
    ruleAllows(inspection, 'cli/routes.test.ts', 'orchestrator/src/agent/agent-commands.ts'),
  ).toBeTrue()
  expect(ruleAllows(inspection, 'cli/routes.test.ts', 'orchestrator/src/run/exec.ts')).toBeFalse()
})
