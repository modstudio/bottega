import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertProject } from '../test/fixture.ts'
import { selectProjectProfile, setProfile } from './lenses.ts'
import { preflight } from './dispatch-preflight.ts'
import { resolveBase } from './worktree.ts'

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
  const repo = mkdtempSync(join(tmpdir(), 'orch-create-command-'))
  try {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
    git('init', '-b', 'main'); git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
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
