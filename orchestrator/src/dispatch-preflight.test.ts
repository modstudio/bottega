import { expect, test } from 'bun:test'
import { declaredCreate, upsertProject } from '../test/fixture.ts'
import { selectProjectProfile, setProfile } from './lenses.ts'
import { preflight } from './dispatch-preflight.ts'

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
  upsertProject({ name: 'needs-key', path: process.cwd(), settings: { worktree: { branch: 'feature/{key}-{id}' } } })
  expect(() => preflight('implement', process.cwd())).toThrow('--key <KEY-123>')
})

test('an explicit base without a {base} slot is not refused at preflight', () => {
  upsertProject({ name: 'cannot-base', path: process.cwd(), settings: { worktree: { create: declaredCreate('scripts/worktree', ['create', '{branch}']), branch: 'feature/{id}' } } })
  expect(() => preflight('implement', process.cwd(), undefined, undefined, 'HEAD')).not.toThrow()
})

test('non-commit bases are refused before every dispatch artifact', () => {
  expect(() => preflight('implement', process.cwd(), undefined, undefined, '0123456789012345678901234567890123456789')).toThrow(/single revision|commit/)
})
