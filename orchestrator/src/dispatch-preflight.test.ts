import { expect, test } from 'bun:test'
import { upsertProject } from '../test/fixture.ts'
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
