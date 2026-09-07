import { describe,expect,test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync,mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db,upsertProject } from '../test/fixture.ts'
import { REGISTERED_LIVE_STORE } from '../test/preload.ts'
import { applyMigrations } from './migrations.ts'
import { listLenses,resolveLens,selectProjectProfile,setLens,setProfile } from './lenses.ts'
import { preflight } from './run.ts'

describe('lens catalogue',()=>{
  test('six seeded cores render their default profile for every registered project',()=>{
    upsertProject({name:'one',path:'/tmp/one',settings:{}})
    upsertProject({name:'two',path:'/tmp/two',settings:{}})
    expect(listLenses().map(x=>x.id)).toEqual(['correctness','craft','issue-blast-radius','migration-safety','safety','teardown-safety'])
    for(const lens of listLenses()) for(const project of ['one','two']) {
      const resolved=resolveLens(lens.id,project)!
      expect(resolved.profiles).toEqual([{axis:'framework',name:'default',version:1}])
      expect(resolved.body).toBe(`QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}\n\nFRAMEWORK GUIDANCE\nNo framework-specific guidance for this stack.\n\nCOMMANDS\nNone.`)
    }
  })

  test('profile validation refuses undeclared slots and project selection binds one shared row',()=>{
    upsertProject({name:'one',path:'/tmp/one',settings:{}});upsertProject({name:'two',path:'/tmp/two',settings:{}})
    expect(()=>setProfile({lensId:'correctness',axis:'framework',name:'node',body:'{"not_declared":"x"}',enabled:true,reason:'test'})).toThrow('undeclared slot')
    setProfile({lensId:'correctness',axis:'framework',name:'node',body:'{"framework_guidance":"Node.","commands":"bun test"}',enabled:true,reason:'test'})
    selectProjectProfile({project:'one',axis:'framework',name:'node',lensId:'correctness',reason:'test'})
    selectProjectProfile({project:'two',axis:'framework',name:'node',lensId:'correctness',reason:'test'})
    expect(db().query("SELECT COUNT(*) n FROM lens_profile WHERE lens_id='correctness' AND name='node'").get()).toEqual({n:1})
    expect(resolveLens('correctness','one')!.body).toContain('Node.\n\nCOMMANDS\nbun test')
    expect(resolveLens('correctness','two')!.profiles[0]!.name).toBe('node')
    selectProjectProfile({project:'one',axis:'framework',name:'default',lensId:'correctness',version:1,reason:'return to baseline'})
    expect(db().query(`SELECT prior_profile_name,prior_selected_version,reason FROM project_lens_profile_revision`).get())
      .toEqual({prior_profile_name:'node',prior_selected_version:null,reason:'return to baseline'})
  })

  test('unknown lenses remain free-form while disabled catalogue content refuses',()=>{
    expect(resolveLens('a-live-ad-hoc-calibration-key','one')).toBeNull()
    const correctness=listLenses().find((lens)=>lens.id==='correctness')!
    setLens({id:correctness.id,title:correctness.title,question:correctness.question,excludes:correctness.excludes,
      slots:JSON.stringify(correctness.slots),enabled:false,reason:'test switch-off'})
    expect(()=>resolveLens('correctness','one')).toThrow('invariant: A disabled catalogue lens or selected profile never dispatches.')
    expect(()=>resolveLens('correctness','one')).toThrow('cleared by:')
  })

  test('a disabled unselected profile does not introduce its axis',()=>{
    upsertProject({name:'one',path:'/tmp/one',settings:{}})
    const before=resolveLens('correctness','one')
    setProfile({lensId:'correctness',axis:'architecture',name:'retired',body:'{}',enabled:false,reason:'probe disabled axis'})
    expect(resolveLens('correctness','one')).toEqual(before)
  })

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

  test('a copy of the live store migrates with every populated project reference resolved',()=>{
    const dir=mkdtempSync(join(tmpdir(),'orch-live-lens-'));const path=join(dir,'orch.db');copyFileSync(REGISTERED_LIVE_STORE,path)
    const live=new Database(path,{readwrite:true});live.exec('PRAGMA foreign_keys=ON')
    try {
      applyMigrations(live)
      for(const [table,where] of [
        ['run','repo IS NOT NULL'],['canon_pack','project IS NOT NULL'],['landing','1'],
        ['landing_override','1'],['landing_review_carry','1'],['doc',"scope='project'"],['doc_revision',"scope='project'"],
      ]) expect((live.query(`SELECT COUNT(*) n FROM ${table} WHERE ${where} AND project_id IS NULL`).get() as {n:number}).n,table).toBe(0)
      expect((live.query(`SELECT COUNT(*) n FROM review rv WHERE rv.project_id IS NULL
        AND 1=(SELECT COUNT(DISTINCT r.project_id) FROM review_lens rl JOIN run r ON r.id=rl.run_id WHERE rl.review_id=rv.id)
        AND 0=(SELECT COUNT(*) FROM review_lens rl JOIN run r ON r.id=rl.run_id WHERE rl.review_id=rv.id AND r.project_id IS NULL)`).get() as {n:number}).n).toBe(0)
    } finally {live.close();rmSync(dir,{recursive:true,force:true})}
  })
})
