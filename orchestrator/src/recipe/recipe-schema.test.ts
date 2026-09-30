import { describe, expect, test } from 'bun:test'
import {
  allocationEnvironmentVariable,
  configDocumentSchema,
  hookBranchName,
  recipeSchema,
  stepPlaceholders,
} from './recipe-schema.ts'

const command: { command: string; args: string[]; cwd?: string } = { command: 'true', args: [] }
const minimal = () => ({ create: [{ name: 'create', run: command }] })

function messages(value: unknown): string[] {
  const parsed = recipeSchema.safeParse(value)
  expect(parsed.success).toBe(false)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('tracked recipe refusal rules', () => {
  test('accepts refresh steps and refuses undo in a refresh step', () => {
    expect(
      recipeSchema.safeParse({
        create: [],
        refresh: [{ name: 'dependencies', run: command }],
      }).success,
    ).toBe(true)
    expect(
      messages({
        create: [],
        refresh: [{ name: 'dependencies', run: command, undo: command }],
      }).join('\n'),
    ).toContain('unknown-key rule')
  })

  test('names placeholders in text and structured step arguments', () => {
    expect(
      stepPlaceholders({
        name: 'refresh',
        run: {
          command: 'run-{branch}',
          args: ['{ports.web}', { value: '--key={key}', omitWhenEmpty: 'key' }, { expand: 'seed' }],
        },
      }),
    ).toEqual([
      { name: 'branch', allocation: false },
      { name: 'ports.web', allocation: true },
      { name: 'key', allocation: false },
      { name: 'seed', allocation: false },
    ])
  })

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

  test('accepts valid provisions and refuses malformed or duplicate entries', () => {
    const omitted = recipeSchema.safeParse({
      create: [],
      provision: [{ path: 'node_modules', method: 'link' }],
    })
    expect(omitted.success).toBe(true)
    if (omitted.success) expect(omitted.data.provision?.[0]?.required).toBe(false)
    expect(
      recipeSchema.safeParse({
        create: [],
        provision: [
          { path: 'node_modules', method: 'link', required: true },
          { path: 'vendor', method: 'clone' },
        ],
      }).success,
    ).toBe(true)
    expect(
      messages({ create: [], provision: [{ path: '../vendor', method: 'clone' }] }).join('\n'),
    ).toContain('provision path')
    expect(
      messages({ create: [], provision: [{ path: 'vendor', method: 'copy' }] }).join('\n'),
    ).toContain('Invalid option')
    expect(
      messages({ create: [], provision: [{ path: 'vendor', method: 'clone', extra: true }] }).join(
        '\n',
      ),
    ).toContain('unknown-key rule')
    expect(
      messages({
        create: [],
        provision: [
          { path: 'vendor', method: 'clone' },
          { path: 'vendor', method: 'link' },
        ],
      }).join('\n'),
    ).toContain('provision path must be unique')
  })

  test('refuses an unknown key', () => {
    expect(messages({ ...minimal(), mystery: true }).join('\n')).toContain('unknown-key rule')
  })

  test('refuses duplicate step names anywhere in one recipe', () => {
    expect(
      messages({ ...minimal(), verifyDown: [{ name: 'create', run: command }] }).join('\n'),
    ).toContain('duplicate step name')
  })

  test('catches replacing the unknown-placeholder refusal with permissive validation', () => {
    const recipe = minimal()
    recipe.create[0]!.run = { command: 'true', args: ['{mystery}'] }
    expect(messages(recipe).join('\n')).toContain('unknown placeholder {mystery}')
  })

  test('catches removing tree_exists from the step placeholder allowlist', () => {
    const recipe = minimal()
    recipe.create[0]!.run = { command: 'true', args: ['{tree_exists}'] }
    expect(recipeSchema.safeParse(recipe).success).toBe(true)
  })

  test('accepts the ownership label in tracked steps but not allocation templates', () => {
    expect(
      recipeSchema.safeParse({
        create: [
          {
            name: 'compose',
            run: { command: 'docker', args: ['run', '--label', '{label}'] },
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      messages({ allocate: { strings: { resource: '{label}' } }, create: [] }).join('\n'),
    ).toContain('string allocation "resource" may use only')
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

  test('a database name may use static values and index but not another allocation', () => {
    expect(
      recipeSchema.safeParse({
        allocate: {
          databases: {
            app: { engine: 'postgres', name: '{name}_{index}' },
            audit: { engine: 'mysql', name: '{branch}_audit' },
          },
        },
        create: [],
      }).success,
    ).toBe(true)
    expect(
      messages({
        allocate: {
          ports: ['web'],
          databases: { app: { engine: 'postgres', name: '{ports.web}' } },
        },
        create: [],
      }).join('\n'),
    ).toContain(
      'placeholder rule: database allocation "app" may use only {branch} {name} {base} {key} {seed} {path} {main} {index}',
    )
  })

  test('a database allocation no longer accepts a provider object', () => {
    expect(
      messages({
        allocate: { databases: { app: { kind: 'compose', up: 'up', down: 'down' } } },
        create: [],
      }).join('\n'),
    ).toContain('unknown-key rule')
  })

  test('refuses absolute and parent-traversing command working directories', () => {
    for (const cwd of ['/tmp/app', 'packages/../other']) {
      const recipe = minimal()
      recipe.create[0]!.run = { ...command, cwd }
      expect(messages(recipe).join('\n')).toContain('cwd rule')
    }
  })

  test('refuses absolute and parent-traversing env paths and inherited paths', () => {
    for (const [field, path] of [
      ['path', '/tmp/.env'],
      ['path', 'config/../.env'],
      ['inherit', '/main/.env'],
      ['inherit', 'config/../.env'],
    ] as const) {
      expect(
        messages({
          create: [],
          env: [{ path: '.env', contents: '', [field]: path }],
        }).join('\n'),
      ).toContain(`env-file ${field} rule`)
    }
  })

  test('refuses duplicate shared names', () => {
    expect(
      messages({
        create: [],
        shared: [
          { name: 'cache', kind: 'path', from: 'cache' },
          { name: 'cache', kind: 'volume', from: 'volume' },
        ],
      }).join('\n'),
    ).toContain('shared-name rule: duplicate shared name "cache" within recipe')
  })

  test('refuses absolute and parent-traversing shared path and volume sources', () => {
    for (const [kind, from] of [
      ['path', '/main/vendor'],
      ['path', 'main/../vendor'],
      ['volume', 'C:\\volumes\\cache'],
      ['volume', 'volumes\\..\\cache'],
    ] as const) {
      expect(
        messages({ create: [], shared: [{ name: 'shared', kind, from }] }).join('\n'),
      ).toContain(`shared from rule: ${kind} "shared"`)
    }
  })

  test('refuses slashes in network and service source identifiers', () => {
    for (const kind of ['network', 'service'] as const) {
      expect(
        messages({
          create: [],
          shared: [{ name: 'shared', kind, from: 'compose/shared' }],
        }).join('\n'),
      ).toContain(`shared from rule: ${kind} "shared" must be an identifier containing no slash`)
    }
  })

  test('refuses absolute and parent-traversing shared targets', () => {
    for (const at of ['/tree/vendor', 'tree/../vendor', 'C:\\tree\\vendor']) {
      expect(
        messages({
          create: [],
          shared: [{ name: 'vendor', kind: 'path', from: 'vendor', at }],
        }).join('\n'),
      ).toContain('shared at rule: shared "vendor"')
    }
  })

  test('refuses shared target collisions naming both declarations', () => {
    const errors = messages({
      create: [],
      shared: [
        { name: 'vendor', kind: 'path', from: 'vendor', at: 'deps' },
        { name: 'modules', kind: 'volume', from: 'modules', at: 'deps' },
      ],
    }).join('\n')
    expect(errors).toContain('shared "vendor" and shared "modules" both declare at "deps"')
  })

  test('refuses a shared target colliding with an env path naming both', () => {
    const errors = messages({
      create: [],
      env: [{ path: '.env', contents: '' }],
      shared: [{ name: 'settings', kind: 'path', from: 'settings', at: '.env' }],
    }).join('\n')
    expect(errors).toContain('shared "settings" at ".env" collides with env path ".env"')
  })

  test('parses every shared kind and defaults targets to source basenames', () => {
    const parsed = recipeSchema.parse({
      create: [],
      shared: [
        { name: 'vendor', kind: 'path', from: 'main/vendor' },
        { name: 'modules', kind: 'volume', from: 'cache/node_modules' },
        { name: 'edge', kind: 'network', from: 'edge' },
        { name: 'redis', kind: 'service', from: 'redis' },
      ],
    })
    expect(parsed.shared?.map((entry) => entry.at)).toEqual([
      'vendor',
      'node_modules',
      'edge',
      'redis',
    ])
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

  test('rule 1 refuses a serve step without undo', () => {
    expect(
      messages({
        create: [],
        serve: { preview: [{ name: 'web', run: command }] },
      }).join('\n'),
    ).toContain('rule 1: serve step "web" in mode "preview" must declare undo')
  })

  test('refuses allocation names that collide after environment normalization', () => {
    expect(
      messages({
        allocate: { ports: ['api-v2', 'api.v2'] },
        create: [],
      }).join('\n'),
    ).toContain(
      'allocation names "api-v2" and "api.v2" map to the same environment variable ORCH_PORTS_API_V2',
    )
    expect(
      messages({
        allocate: {
          databases: {
            'app-v2': { engine: 'postgres', name: 'app_{index}' },
            'app.v2': { engine: 'postgres', name: 'other_{index}' },
          },
        },
        create: [],
      }).join('\n'),
    ).toContain('map to the same environment variable ORCH_DB_APP_V2')
  })

  test('names allocation environment variables', () => {
    expect(allocationEnvironmentVariable('ports', 'hub')).toBe('ORCH_PORTS_HUB')
    expect(allocationEnvironmentVariable('ports', 'api-v2')).toBe('ORCH_PORTS_API_V2')
    expect(allocationEnvironmentVariable('db', 'app-v2')).toBe('ORCH_DB_APP_V2')
  })
})

describe('project config document', () => {
  test('decides default and declared hook branches and refuses other placeholders', () => {
    const defaulted = configDocumentSchema.parse({ worktree: minimal() }).worktree!
    expect(hookBranchName(defaulted.hookBranch, 'alice')).toBe('worktree-alice')

    const declared = configDocumentSchema.parse({
      worktree: { ...minimal(), hookBranch: 'session/{name}' },
    }).worktree!
    expect(hookBranchName(declared.hookBranch, 'alice')).toBe('session/alice')

    const refused = configDocumentSchema.safeParse({
      worktree: { ...minimal(), hookBranch: 'session/{id}' },
    })
    expect(refused.success).toBe(false)
    if (!refused.success) expect(refused.error.issues[0]?.message).toContain('may use only {name}')
  })

  test('accepts a nested worktree recipe and an optional root schema', () => {
    expect(
      configDocumentSchema.safeParse({ $schema: 'schema.json', worktree: minimal() }).success,
    ).toBe(true)
    expect(
      configDocumentSchema.safeParse({
        worktree: { ...minimal(), relativePaths: true },
      }).success,
    ).toBe(true)
    expect(
      configDocumentSchema.safeParse({
        worktree: { ...minimal(), relativePaths: 'true' },
      }).success,
    ).toBe(false)
  })

  test('accepts a document with no worktree lifecycle', () => {
    expect(configDocumentSchema.safeParse({}).success).toBe(true)
  })

  test('refuses unknown top-level keys', () => {
    const parsed = configDocumentSchema.safeParse({ mystery: true })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('unknown-key rule')
  })

  test('refuses a schema declaration inside the worktree recipe', () => {
    const parsed = configDocumentSchema.safeParse({
      worktree: { $schema: 'schema.json', ...minimal() },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('unknown-key rule')
  })
})
