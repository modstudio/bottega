import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import {
  creditedMeasurementCommands,
  decideClassMeasuredFloor,
  renderClassMeasurementCommand,
  treeRelativeArgv,
} from './workflow-class-measured-floor.ts'

const artifact = (overrides: Record<string, unknown> = {}): ValidatedArtifactEvidence => ({
  artifact: { ref: 'exec:7', exists: true },
  exec: {
    id: 7,
    recordId: 'exec-record',
    command: 'rg defect | wc -l',
    argv: ['sh', '-c', 'rg defect | wc -l'],
    exitCode: 0,
    sessionMatches: true,
    sessionAdoptedCursor: false,
    createdAfterStepActivation: true,
    checkoutLocation: 'branch',
    headCommit: null,
    cursorBranch: null,
    output: 'detail\n3\n',
    ...overrides,
  },
})

const checkoutRoot = '/Users/shmuel/Projects/stopal'
const decide = (artifacts: readonly ValidatedArtifactEvidence[], checkoutRoots: string[] = []) =>
  decideClassMeasuredFloor({ className: 'reader leak', artifacts, checkoutRoots })

describe('class-measured floor', () => {
  test('records the class, command, exec and count', () => {
    expect(decide([artifact()])).toEqual({
      met: true,
      measurement: {
        className: 'reader leak',
        command: "'sh' '-c' 'rg defect | wc -l'",
        execId: 7,
        count: 3,
      },
    })
  })

  test.each([
    ['missing class', undefined, [artifact()], '--class is missing'],
    ['missing artifact', 'reader leak', [], 'exactly one exec artifact'],
    ['several artifacts', 'reader leak', [artifact(), artifact()], 'exactly one exec artifact'],
    ['failed exec', 'reader leak', [artifact({ exitCode: 2 })], 'exited 2'],
    ['stale exec', 'reader leak', [artifact({ createdAfterStepActivation: false })], 'predates'],
    ['legacy command', 'reader leak', [artifact({ argv: null })], 'structured command'],
    [
      'withheld command',
      'reader leak',
      [artifact({ argv: null, commandWithheld: true })],
      'structured command',
    ],
    ['non-integer count', 'reader leak', [artifact({ output: 'many\n' })], 'non-negative integer'],
  ])('%s refuses', (_name, className, artifacts, message) => {
    const decision = decideClassMeasuredFloor({ className, artifacts, checkoutRoots: [] })
    expect(decision.met ? '' : decision.message).toContain(message)
  })

  test('refuses a secret-shaped class without echoing it', () => {
    const secret = 'ghp_123456789012345678901234567890123456'
    const decision = decideClassMeasuredFloor({
      className: secret,
      artifacts: [artifact()],
      checkoutRoots: [],
    })
    expect(decision.met).toBe(false)
    if (!decision.met) {
      expect(decision.message).toContain('secret-shaped')
      expect(decision.message).not.toContain(secret)
    }
  })

  test.each([
    ['bare root', ['bash', '/tmp/measure.sh', checkoutRoot]],
    [
      'worktree under root',
      ['bash', `${checkoutRoot}/.claude/worktrees/STO-1389/scripts/measure.ts`],
    ],
    ['flag value', ['bun', `--cwd=${checkoutRoot}/scripts`]],
    ['shell command', ['sh', '-c', `bun ${checkoutRoot}/scripts/measure.ts`]],
  ])('refuses a checkout path in a %s argument', (_name, argv) => {
    const decision = decide([artifact({ argv })], [checkoutRoot])
    expect(decision.met).toBe(false)
  })

  test.each([
    ['sibling prefix', ['bash', `${checkoutRoot}2/scripts/measure.ts`]],
    ['executable', [`${checkoutRoot}/bin/${PLATFORM_SLUG}`, 'workflow', 'class-audit']],
    ['relative argument', ['bash', 'scripts/measure.sh', '.']],
  ])('allows a %s path', (_name, argv) => {
    expect(decide([artifact({ argv })], [checkoutRoot]).met).toBe(true)
  })

  test('checkout-path refusal names the absolute and tree-relative paths', () => {
    const absolute = `${checkoutRoot}/scripts/measure.ts`
    const decision = decide([artifact({ argv: ['bun', `--script=${absolute}`] })], [checkoutRoot])
    expect(decision.met).toBe(false)
    if (!decision.met) {
      expect(decision.message).toContain(absolute)
      expect(decision.message).toContain('scripts/measure.ts')
    }
  })

  test('renders structured argv with one canonical shell quoting rule', () => {
    expect(renderClassMeasurementCommand(['sh', '-c', "rg 'reader leak' | wc -l"])).toBe(
      String.raw`'sh' '-c' 'rg '\''reader leak'\'' | wc -l'`,
    )
  })

  test('rewrites every checkout occurrence to its tree-relative form', () => {
    expect(
      treeRelativeArgv(
        ['bun', `${checkoutRoot}/first.ts ${checkoutRoot}/scripts/measure.ts`, checkoutRoot],
        [checkoutRoot],
      ),
    ).toEqual(['bun', 'first.ts scripts/measure.ts', '.'])
  })

  test('never rewrites argv zero even when it names a checkout', () => {
    expect(treeRelativeArgv([checkoutRoot, checkoutRoot], [checkoutRoot])).toEqual([
      checkoutRoot,
      '.',
    ])
  })

  test('does not rewrite a sibling whose name starts with the checkout root', () => {
    expect(
      treeRelativeArgv(['bun', `${checkoutRoot}2/scripts/measure.ts`], [checkoutRoot]),
    ).toEqual(['bun', `${checkoutRoot}2/scripts/measure.ts`])
  })

  test('credits only the recorded command when it names no checkout', () => {
    const command = renderClassMeasurementCommand(['bun', 'scripts/measure.ts', '.'])!
    expect(creditedMeasurementCommands(command, [checkoutRoot])).toEqual([command])
  })

  test('credits the recorded and tree-relative commands when it names a checkout', () => {
    const command = renderClassMeasurementCommand(['bun', 'scripts/measure.ts', checkoutRoot])!
    const treeRelativeCommand = renderClassMeasurementCommand([
      'bun',
      'scripts/measure.ts',
      '.',
    ])!
    expect(creditedMeasurementCommands(command, [checkoutRoot])).toEqual([
      command,
      treeRelativeCommand,
    ])
  })

  test('floor satisfaction does not add its measurement to the input evidence', async () => {
    const { decideFloorSatisfaction } = await import('./workflow-floor.ts')
    const evidence = { className: 'reader leak', artifacts: [artifact()] }
    expect(
      decideFloorSatisfaction({
        floors: [
          {
            kind: 'class-measured',
            deferrable: false,
            expectedExitCode: 0,
            expectedStatus: 'done',
            requirePullRequest: false,
            operatorRuling: false,
          },
        ],
        evidence,
        enforcement: 'floors',
        finishing: false,
        openObligations: [],
      }).action,
    ).toBe('allow')
    expect(evidence).not.toHaveProperty('classMeasurement')
  })
})
