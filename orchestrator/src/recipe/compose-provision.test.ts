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

  test('records ownership after attempting up and compensates a later failure with down', () => {
    const calls: string[][] = []
    const spawn: ComposeSpawn = (argv) => {
      calls.push(argv)
      return output()
    }
    const created = createCompose(recipe, context, spawn)
    expect(created).toMatchObject({ step: { status: 'ok' }, owned: true })
    const laterStepFailed = true
    const compensated = laterStepFailed ? downCompose(recipe, context, created.owned, spawn) : null
    expect(compensated).toMatchObject({ status: 'ok', phase: 'verify' })
    expect(calls.some((argv) => argv.includes('up'))).toBeTrue()
    expect(calls.some((argv) => argv.includes('down'))).toBeTrue()
  })

  test('omits file arguments when teardown runs after the tree is gone', () => {
    const calls: string[][] = []
    const spawn: ComposeSpawn = (argv) => {
      calls.push(argv)
      return output()
    }
    expect(
      downCompose(
        recipe,
        { ...context, commandRoot: '/tmp/teardown', treeExists: false },
        true,
        spawn,
      ),
    ).toMatchObject({ status: 'ok' })
    const down = calls.find((argv) => argv.includes('down'))!
    expect(down).not.toContain('-f')
    expect(down).toContain('app-orch-42')
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
