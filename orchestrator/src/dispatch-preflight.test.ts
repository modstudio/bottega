import { expect, test, describe } from "bun:test"
import { cloneRepository } from '../test/fixtures/git.ts'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { declaredCreate, worktreeDescribeFixture } from '../test/fixtures/worktree.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { createArgv } from './worktree-template.ts'
import { selectProjectProfile, setProfile } from "./lenses.ts"
import { preflight } from "./dispatch-preflight.ts"
import { resolveBase } from "./worktree.ts"
test('--repo makes preflight resolve the dispatch project in both directions',()=>{
  const priorDepth=process.env.ORCH_DEPTH
  process.env.ORCH_DEPTH='0'
  try {
  upsertProject({name:'cwd-project',path:process.cwd(),settings:{}})
  upsertProject({name:'dispatch-project',path:'/tmp/dispatch-project',settings:{}})
  setProfile({lensId:'correctness',axis:'framework',name:'off',body:'{}',enabled:true,reason:'probe profile'})
  selectProjectProfile({project:'cwd-project',axis:'framework',name:'off',lensId:'correctness',reason:'cwd selects it'})
  setProfile({lensId:'correctness',axis:'framework',name:'off',body:'{}',enabled:false,reason:'disable for cwd'})
  expect(()=>preflight('review-lens',process.cwd(),undefined,undefined,undefined,false,false,'correctness',undefined,false,'dispatch-project')).not.toThrow()

  setProfile({lensId:'correctness',axis:'framework',name:'off',body:'{}',enabled:true,reason:'enable to select'})
  selectProjectProfile({project:'cwd-project',axis:'framework',name:'default',lensId:'correctness',reason:'cwd returns to default'})
  selectProjectProfile({project:'dispatch-project',axis:'framework',name:'off',lensId:'correctness',reason:'dispatch selects it'})
  setProfile({lensId:'correctness',axis:'framework',name:'off',body:'{}',enabled:false,reason:'disable for dispatch'})
  expect(()=>preflight('review-lens',process.cwd(),undefined,undefined,undefined,false,false,'correctness',undefined,false,'dispatch-project'))
    .toThrow('selected disabled framework profile "off"')
  } finally {
    if(priorDepth===undefined) delete process.env.ORCH_DEPTH
    else process.env.ORCH_DEPTH=priorDepth
  }
})

test('required project flags are rejected before the prompt file is read', () => {
  process.env.ORCH_DEPTH = '0'
  upsertProject({ name: 'needs-key', path: process.cwd(), settings: { worktree: { branch: 'feature/{key}-{id}' } } })
  expect(() => preflight('implement', process.cwd())).toThrow('--key <KEY-123>')
})

test('an explicit base without a {base} slot is not refused at preflight', () => {
  process.env.ORCH_DEPTH = '0'
  upsertProject({ name: 'cannot-base', path: process.cwd(), settings: { worktree: { create: { command: 'true', args: [] }, branch: 'feature/{id}' } } })
  expect(() => preflight('implement', process.cwd(), undefined, undefined, 'HEAD')).not.toThrow()
})

test('non-commit bases are refused before every dispatch artifact', () => {
  process.env.ORCH_DEPTH = '0'
  const tree = Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: process.cwd(), stdout: 'pipe' }).stdout.toString().trim()
  expect(() => resolveBase(process.cwd(), tree)).toThrow(/tree|commit/)
})

test('create commands must exist and be executable before dispatch', () => {
  const repo = cloneRepository('orch-create-command-')
  try {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    git('add', '.'); git('commit', '-m', 'fixture')
    upsertProject({ name: 'create-command', path: repo, settings: {
      worktree: { create: { command: 'scripts/missing-worktree', args: ['{branch}'] }, branch: 'task/{id}' },
      requireCleanMain: false,
    } })
    expect(() => preflight('implement', repo)).toThrow(
      'project create-command worktree create command scripts/missing-worktree is absent or not executable',
    )
    const command = join(repo, 'present-worktree')
    writeFileSync(command, '#!/bin/sh\nexit 0\n'); chmodSync(command, 0o755)
    upsertProject({ name: 'create-command', path: repo, settings: {
      worktree: { create: { command, args: ['{branch}'] }, branch: 'task/{id}' },
      requireCleanMain: false,
    } })
    expect(() => preflight('implement', repo)).not.toThrow()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

describe('worktree dispatch preflight', () => {
const { fromRoot, scratchRepo } = worktreeDescribeFixture()
test('review-lens preflight requires a git checkout', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orch-no-repo-'))
    const { repo } = scratchRepo()
    const priorDepth = process.env.ORCH_DEPTH
    try {
      process.env.ORCH_DEPTH = '0'
      expect(() => preflight('review-lens', outside, undefined, undefined, undefined, false, false, 'scope')).toThrow('not inside a git checkout')
      expect(() => preflight('review-lens', repo, undefined, undefined, undefined, false, false, 'scope')).not.toThrow()
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(outside, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('preflight refuses a create command without a branch template', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-branch', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']) } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'orch project set no-branch --settings \'{"worktree":{"branch":"<template>"}}\'',
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight lets a legacy create reach worktree creation with its string arguments', () => {
    const { repo } = scratchRepo()
    const capture = join(repo, 'legacy-create-argv')
    const createTool = join(repo, 'legacy-create')
    writeFileSync(createTool, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(capture)}
exit 17
`)
    chmodSync(createTool, 0o755)
    const create = `${createTool} create "{branch}"`
    upsertProject({
      name: 'legacy-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('orch.ts', import.meta.url).pathname,
      'do', 'implement', 'inspect', '--follow',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain("the project's worktree tool failed")
    const created = db().query('SELECT id FROM run ORDER BY id DESC LIMIT 1').get() as { id: number }
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      'create', `task/${created.id}`,
    ])
    expect(createArgv(create, { branch: `task/${created.id}` })).toEqual([
      'sh', '-c', `${createTool} create "task/${created.id}"`,
    ])
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before + 1)
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight refuses a structured create missing args before any run row exists', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'malformed-preflight', path: realpathSync(repo),
      settings: {
        worktree: { create: { command: 'scripts/worktree' }, branch: 'task/{id}' },
      } as any,
    })
    const before = (db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n
    const r = Bun.spawnSync([
      process.execPath, new URL('orch.ts', import.meta.url).pathname, 'do', 'implement', 'inspect',
    ], {
      cwd: repo,
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'orch-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('worktree.create.args must be an array')
    expect((db().query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(before)
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight accepts an explicit base even when a command template has no {base} slot', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-base-placeholder', path: realpathSync(repo),
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'task/{id}',
        },
      },
    })
    try {
      try {
        fromRoot(() => preflight(
          'implement', realpathSync(repo), undefined, undefined, 'main',
        ))
        throw new Error('expected preflight to throw')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('absent or not executable')
        expect(message).not.toContain('has no {base} slot')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('preflight refuses shell metacharacters in a key', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'bad-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-70; touch nope')))
      .toThrow('key "DEV-70; touch nope" does not match ^[A-Z][A-Z0-9]+-[0-9]+$')
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight reports missing key and seed together', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'missing-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>\n` +
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed=small\n  --seed full\n  --seed=full\n` +
      `Multi-token seed specs must be quoted as one value, for example:\n` +
      `  --seed "--bundle=catalog --budget-mb=700"\n` +
      `  --seed="--bundle=catalog --budget-mb=700"\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).toThrow(
      `this project's branch names must carry a ticket key ({key}-orch-{id}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
    expect(() => fromRoot(() => preflight('implement', repo, undefined, 'DEV-61'))).toThrow(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed small\n  --seed=small\n  --seed full\n  --seed=full\n` +
      `Multi-token seed specs must be quoted as one value, for example:\n` +
      `  --seed "--bundle=catalog --budget-mb=700"\n` +
      `  --seed="--bundle=catalog --budget-mb=700"\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('read-only preflight does not require a writing branch key and refuses seeds', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-arguments', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: '{key}-orch-{id}',
          seeds: ['none', 'small', 'full'],
        },
      },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, 'DEV-264', undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(() => fromRoot(() => preflight(
      'review-lens', repo, 'small', 'DEV-264', undefined, false, false, 'safety',
    ))).toThrow('seeds belong to writing runs')
    rmSync(repo, { recursive: true, force: true })
  })

test('jobs that cut no worktree do not require the branch template key', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'inline-no-key', path: repo,
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    expect(() => fromRoot(() => preflight('summarize', repo))).not.toThrow()
    expect(() => fromRoot(() => preflight(
      'review-lens-inline', repo, undefined, undefined, undefined, false, false, 'inline',
    ))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

test('read-only preflight ignores a writing recipe seed list', () => {
    const { repo } = scratchRepo()
    const trees = join(repo, '.claude', 'worktrees')
    upsertProject({
      name: 'read-only-no-none', path: repo,
      settings: {
        worktree: {
          create: declaredCreate('scripts/worktree', ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    const before = readdirSync(trees).sort()
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    expect(readdirSync(trees).sort()).toEqual(before)
    rmSync(repo, { recursive: true, force: true })
  })

test('read-only preflight leaves a project without listed seeds unaffected', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'read-only-unseeded', path: repo,
      settings: { worktree: { create: declaredCreate(process.execPath, ['create', '{branch}']), branch: 'task/{id}' } },
    })
    expect(fromRoot(() => preflight(
      'review-lens', repo, undefined, undefined, undefined, false, false, 'safety',
    ))).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight refuses a create placeholder without --seed even when no seeds are listed', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'no-seed', path: repo,
      settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{seed}']), branch: 'task/{id}' } },
    })
    expect(() => fromRoot(() => preflight('implement', repo))).toThrow(
      'contain {seed}, so a seed is required',
    )
    rmSync(repo, { recursive: true, force: true })
  })

test('preflight accepts a branch template and a listed seed', () => {
    const { repo } = scratchRepo()
    upsertProject({
      name: 'good-tool', path: repo,
      settings: {
        worktree: {
          create: declaredCreate(process.execPath, ['create', '{branch}', '{seed}']), branch: 'task/{id}',
          seeds: ['small', 'full'],
        },
      },
    })
    expect(() => fromRoot(() => preflight('implement', repo, 'small'))).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })

})
