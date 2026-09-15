import { describe, expect, test } from 'bun:test'
import { recipeSchema } from './recipe-schema.ts'
import {
  type Command,
  runStep,
  type Spawn,
  type Step,
  type StepProcessResult,
  stepCommandPlan,
  stepOutcome,
} from './recipe-step.ts'

const root = '/tmp/recipe-tree'
const context = {
  treeRoot: root,
  vars: { seed: '--table=users', branch: 'feature/DEV-575' },
}
const command = (overrides: Partial<Command> = {}): Command => ({
  command: 'tool',
  args: ['arg'],
  ...overrides,
})

function processResult(overrides: Partial<StepProcessResult> = {}): StepProcessResult {
  return {
    name: 'build',
    phase: 'run',
    argv: ['tool'],
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 2,
    ...overrides,
  }
}

describe('recipe step command planning', () => {
  test('host commands default to the tree root', () => {
    expect(stepCommandPlan(command(), undefined, context)).toEqual({
      ok: true,
      argv: ['tool', 'arg'],
      cwd: root,
    })
  })

  test('host commands resolve a relative cwd under the tree root', () => {
    expect(stepCommandPlan(command({ cwd: 'packages/api' }), { where: 'host' }, context)).toEqual({
      ok: true,
      argv: ['tool', 'arg'],
      cwd: `${root}/packages/api`,
    })
  })

  test('as-user commands use non-interactive sudo argv exactly', () => {
    expect(stepCommandPlan(command(), { where: 'as-user', user: 'deployer' }, context)).toEqual({
      ok: true,
      argv: ['sudo', '-n', '-u', 'deployer', '--', 'tool', 'arg'],
      cwd: root,
    })
  })

  test('container commands use compose exec without a TTY exactly', () => {
    expect(stepCommandPlan(command(), { where: 'container', service: 'app' }, context)).toEqual({
      ok: true,
      argv: ['docker', 'compose', 'exec', '-T', 'app', 'tool', 'arg'],
      cwd: root,
    })
  })

  test('fills dotted placeholders in commands and arguments', () => {
    expect(
      stepCommandPlan(command({ command: '{bin.name}', args: ['--port={ports.hub}'] }), undefined, {
        treeRoot: root,
        vars: { 'bin.name': 'bun', 'ports.hub': '21345' },
      }),
    ).toEqual({ ok: true, argv: ['bun', '--port=21345'], cwd: root })
  })

  test('refuses a missing placeholder instead of emitting an empty argument', () => {
    expect(
      stepCommandPlan(command({ args: ['{missing}'] }), undefined, context, 'build', 'run'),
    ).toEqual({
      ok: false,
      reason: 'unavailable placeholder {missing} in build.run',
    })
  })

  test('omitWhenEmpty omits an argument for an empty or absent variable', () => {
    expect(
      stepCommandPlan(
        command({ args: [{ value: '--key={key}', omitWhenEmpty: 'key' }] }),
        undefined,
        context,
      ),
    ).toEqual({ ok: true, argv: ['tool'], cwd: root })
  })

  test('omitWhenEmpty keeps and fills an argument for a non-empty variable', () => {
    expect(
      stepCommandPlan(
        command({ args: [{ value: '--branch={branch}', omitWhenEmpty: 'branch' }] }),
        undefined,
        context,
      ),
    ).toEqual({ ok: true, argv: ['tool', '--branch=feature/DEV-575'], cwd: root })
  })

  test('expands a declared seed argument with the existing seed grammar', () => {
    expect(
      stepCommandPlan(command({ args: [{ expand: 'seed' }] }), undefined, {
        treeRoot: root,
        vars: { seed: "--tables='users,roles' --fresh" },
      }),
    ).toEqual({ ok: true, argv: ['tool', '--tables=users,roles', '--fresh'], cwd: root })
  })

  test('refuses a cwd that resolves outside the tree root', () => {
    expect(
      stepCommandPlan(command({ cwd: '../other' }), undefined, context, 'build', 'run'),
    ).toEqual({
      ok: false,
      reason: 'cwd rule: run cwd for step "build" escapes the tree root',
    })
  })

  test('container cwd is refused by the recipe schema', () => {
    const result = recipeSchema.safeParse({
      create: [
        {
          name: 'build',
          run: command({ cwd: 'app' }),
          exec: { where: 'container', service: 'app' },
        },
      ],
    })
    expect(result.success ? [] : result.error.issues.map((issue) => issue.message)).toContain(
      'cwd rule: step "build" runs in a container, where cwd is not supported',
    )
  })

  test('container cwd is refused by command planning', () => {
    expect(
      stepCommandPlan(
        command({ cwd: 'app' }),
        { where: 'container', service: 'app' },
        context,
        'build',
      ),
    ).toEqual({
      ok: false,
      reason: 'cwd rule: step "build" runs in a container, where cwd is not supported',
    })
  })
})

describe('recipe step outcomes', () => {
  test('a failed run decides the result without consulting verify', () => {
    expect(
      stepOutcome(
        processResult({ exitCode: 1, stderr: 'run failed' }),
        processResult({ phase: 'verify', exitCode: 2, stderr: 'verify failed' }),
      ),
    ).toMatchObject({ status: 'failed', phase: 'run', exitCode: 1, detail: 'run failed' })
  })

  test('a failed verify decides the result after a successful run', () => {
    expect(
      stepOutcome(
        processResult(),
        processResult({ phase: 'verify', exitCode: 2, stderr: 'verify failed', durationMs: 3 }),
      ),
    ).toMatchObject({
      status: 'failed',
      phase: 'verify',
      exitCode: 2,
      detail: 'verify failed',
      durationMs: 5,
    })
  })

  test('a successful run with no verify is ok', () => {
    expect(stepOutcome(processResult(), null)).toMatchObject({
      status: 'ok',
      phase: 'run',
      detail: '',
    })
  })
})

describe('recipe step execution', () => {
  test('does not spawn verify after a failed run', () => {
    const calls: string[][] = []
    const spawn: Spawn = (argv) => {
      calls.push(argv)
      return { exitCode: 1, stdout: '', stderr: 'failed' }
    }
    const step: Step = { name: 'build', run: command(), verify: command({ command: 'check' }) }
    runStep(step, context, spawn)
    expect(calls).toEqual([['tool', 'arg']])
  })

  test('turns a throwing spawn into a failed result', () => {
    const spawn: Spawn = () => {
      throw new Error('binary unavailable')
    }
    expect(runStep({ name: 'build', run: command() }, context, spawn)).toMatchObject({
      name: 'build',
      phase: 'run',
      status: 'failed',
      exitCode: null,
      argv: ['tool', 'arg'],
      detail: 'binary unavailable',
    })
  })
})
