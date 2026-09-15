import { describe, expect, test } from 'bun:test'
import { recipeSchema } from './recipe-schema.ts'

const command: { command: string; args: string[]; cwd?: string } = { command: 'true', args: [] }
const minimal = () => ({ create: [{ name: 'create', run: command }] })

function messages(value: unknown): string[] {
  const parsed = recipeSchema.safeParse(value)
  expect(parsed.success).toBe(false)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('tracked recipe refusal rules', () => {
  test('accepts the minimal recipe and all three execution contexts', () => {
    expect(
      recipeSchema.safeParse({
        create: [
          { name: 'host', run: command, exec: { where: 'host' } },
          {
            name: 'container',
            run: command,
            exec: { where: 'container', service: 'app' },
          },
          { name: 'user', run: command, exec: { where: 'as-user', user: 'deployer' } },
        ],
      }).success,
    ).toBe(true)
  })

  test('refuses an unknown key', () => {
    expect(messages({ ...minimal(), mystery: true }).join('\n')).toContain('unknown-key rule')
  })

  test('refuses duplicate step names anywhere in one recipe', () => {
    expect(
      messages({ ...minimal(), verifyDown: [{ name: 'create', run: command }] }).join('\n'),
    ).toContain('duplicate step name')
  })

  test('refuses an unknown placeholder', () => {
    const recipe = minimal()
    recipe.create[0]!.run = { command: 'true', args: ['{mystery}'] }
    expect(messages(recipe).join('\n')).toContain('unknown placeholder {mystery}')
  })

  test('refuses a named port that was not declared', () => {
    const recipe = minimal()
    recipe.create[0]!.run = { command: 'true', args: ['{ports.web}'] }
    expect(messages(recipe).join('\n')).toContain('{ports.web} names an undeclared port')
  })

  test('a string allocation may use static values and index but not another allocation', () => {
    expect(
      recipeSchema.safeParse({
        allocate: { strings: { cookie: '{name}-{index}' } },
        create: [],
      }).success,
    ).toBe(true)
    expect(
      messages({
        allocate: { ports: ['web'], strings: { cookie: '{ports.web}' } },
        create: [],
      }).join('\n'),
    ).toContain(
      'placeholder rule: string allocation "cookie" may use only {branch} {name} {base} {key} {seed} {path} {main} {index}',
    )
  })

  test('refuses absolute and parent-traversing command working directories', () => {
    for (const cwd of ['/tmp/app', 'packages/../other']) {
      const recipe = minimal()
      recipe.create[0]!.run = { ...command, cwd }
      expect(messages(recipe).join('\n')).toContain('cwd rule')
    }
  })

  test('rule 1 refuses an allocating create step without undo', () => {
    const recipe = {
      allocate: { ports: ['web'] },
      create: [{ name: 'listen', run: { command: 'serve', args: ['{ports.web}'] } }],
    }
    expect(messages(recipe).join('\n')).toContain('rule 1')
    expect(
      recipeSchema.safeParse({
        ...recipe,
        create: [{ ...recipe.create[0], undo: { command: 'stop', args: ['{ports.web}'] } }],
      }).success,
    ).toBe(true)
  })
})
