import { describe, expect, test } from 'bun:test'
import {
  type ComposeProcessOutput,
  type ComposeSpawn,
  createCompose,
  downCompose,
} from './compose-provision.ts'
import { recipeSchema } from './recipe-schema.ts'

const recipe = recipeSchema.parse({ compose: { files: ['compose.yaml'] }, create: [] })
const context = {
  treeRoot: '/trees/orch-42',
  projectName: 'app',
  rootRunId: 42,
  mainComposeProjects: [],
}
const output = (stdout = '', exitCode = 0): ComposeProcessOutput => ({
  exitCode,
  stdout: new TextEncoder().encode(stdout),
  stderr: '',
})

describe('Compose provision adapter', () => {
  test('refuses existing resources without taking ownership or running up', () => {
    const calls: string[][] = []
    const spawn: ComposeSpawn = (argv) => {
      calls.push(argv)
      return argv.includes('ps') ? output('app-orch-42-web-1\n') : output()
    }
    expect(createCompose(recipe, context, spawn)).toMatchObject({
      step: { status: 'refused', detail: expect.stringContaining('app-orch-42-web-1') },
      owned: false,
    })
    expect(calls.some((argv) => argv.includes('up'))).toBeFalse()
  })

  test('records ownership before up and compensates a later failure with config-less down', () => {
    const calls: { argv: string[]; cwd: string }[] = []
    let owned = false
    const spawn: ComposeSpawn = (argv, cwd) => {
      calls.push({ argv, cwd })
      if (argv.includes('up')) expect(owned).toBeTrue()
      return output()
    }
    const created = createCompose(recipe, context, spawn, () => {
      owned = true
    })
    expect(created).toMatchObject({ step: { status: 'ok' }, owned: true })
    const laterStepFailed = true
    const compensated = laterStepFailed ? downCompose(recipe, context, created.owned, spawn) : null
    expect(compensated).toMatchObject({ status: 'ok', phase: 'verify' })
    expect(calls.some(({ argv }) => argv.includes('up'))).toBeTrue()
    const down = calls.find(({ argv }) => argv.includes('down'))!
    expect(down.cwd).not.toBe(context.treeRoot)
    expect(down.argv).toEqual([
      'docker',
      'compose',
      '-p',
      'app-orch-42',
      'down',
      '--volumes',
      '--remove-orphans',
    ])
    expect(down.argv).not.toContain('-f')
    expect(down.argv).not.toContain('--env-file')
  })

  test('ordinary teardown is config-less in a fresh directory even while the tree exists', () => {
    const calls: { argv: string[]; cwd: string }[] = []
    const spawn: ComposeSpawn = (argv, cwd) => {
      calls.push({ argv, cwd })
      return output()
    }
    expect(downCompose(recipe, context, true, spawn)).toMatchObject({ status: 'ok' })
    const down = calls.find(({ argv }) => argv.includes('down'))!
    expect(down.cwd).not.toBe(context.treeRoot)
    expect(down.argv).not.toContain('-f')
    expect(down.argv).not.toContain('--env-file')
    expect(down.argv).toContain('app-orch-42')
  })

  test('fails verification with names of residue left by down', () => {
    const spawn: ComposeSpawn = (argv) => {
      if (argv.includes('network') && argv.includes('ls')) return output('app-orch-42_default\n')
      return output()
    }
    expect(downCompose(recipe, context, true, spawn)).toMatchObject({
      status: 'failed',
      phase: 'verify',
      detail: expect.stringContaining('network app-orch-42_default'),
    })
  })

  test('keeps a stack with no recorded ownership without running down', () => {
    let calls = 0
    expect(
      downCompose(recipe, context, undefined, () => {
        calls += 1
        return output()
      }),
    ).toMatchObject({ status: 'ok', detail: expect.stringContaining('no recorded ownership') })
    expect(calls).toBe(0)
  })
})
