import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applySchema, bootstrapFixtureStore } from './db.ts'
import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED } from './review-vocabulary.ts'
import { composeWorkflow, exportWorkflows, forkWorkflow, getWorkflowStep, importWorkflows,
  listWorkflows, promoteWorkflow, retireWorkflow, setWorkflow, showWorkflow,
  validateWorkflowDefinition, workflowVersions, type WorkflowDefinition } from './workflows.ts'

const valid = (): WorkflowDefinition => ({
  title: 'A workflow', description: 'Does work.',
  arguments: [{ name: 'key', required: true, description: 'Task key' }],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['work'] }],
  steps: [{ slug: 'work', title: 'Work', job: 'implement', autonomy: 'auto', gate: null, body: 'Work on {{key}}.' }],
})
const database = () => { const d = new Database(':memory:'); d.exec('PRAGMA foreign_keys=ON'); applySchema(d); return d }
const temps: string[] = []
afterEach(() => { for (const path of temps.splice(0)) rmSync(path,{recursive:true,force:true}) })

describe('workflow definition validation', () => {
  test('accepts a coherent definition', () => expect(validateWorkflowDefinition(valid())).toEqual([]))
  const cases: [string,(definition:WorkflowDefinition)=>void,string][] = [
    ['malformed slug',d=>{d.steps[0]!.slug='Not valid'},'not well-formed'],
    ['duplicate slug',d=>{d.steps.push({...d.steps[0]!})},'duplicate step slug'],
    ['two defaults',d=>{d.modes.push({slug:'other',title:'Other',default:true,steps:['work']})},'exactly one default'],
    ['entry beside default',d=>{d.modes[0]!.entry='Choose me'},'unreachable entry'],
    ['no entry without default',d=>{delete d.modes[0]!.default},'needs an entry question'],
    ['empty mode',d=>{d.modes[0]!.steps=[]},'at least one step'],
    ['missing step',d=>{d.modes[0]!.steps=['missing']},'references missing step'],
    ['orphan step',d=>{d.steps.push({...d.steps[0]!,slug:'orphan'})},'is orphaned'],
    ['undeclared argument',d=>{d.steps[0]!.body='{{missing}}'},'uses undeclared argument'],
    ['unknown job',d=>{d.steps[0]!.job='imaginary'},'names unknown job'],
    ['bad autonomy',d=>{(d.steps[0] as {autonomy:string}).autonomy='sometimes'},'invalid autonomy'],
    ['empty title',d=>{d.title=''},'title must be non-empty'],
    ['non-string body',d=>{(d.steps[0] as any).body=42},'body must be a string'],
    ['non-array mode steps',d=>{(d.modes[0] as any).steps='x'},'steps must be a string array'],
    ['non-boolean required',d=>{(d.arguments[0] as any).required='yes'},'required must be a boolean'],
  ]
  for (const [name,mutate,message] of cases) test(name,()=>{const d=valid();mutate(d);expect(validateWorkflowDefinition(d).join('\n')).toContain(message)})
  test('reports every violation',()=>{const d=valid();d.title='';d.steps[0]!.job='imaginary';const errors=validateWorkflowDefinition(d);expect(errors).toContain('title must be non-empty');expect(errors.join('\n')).toContain('unknown job')})
})

describe('workflow versions and composition', () => {
  test('set appends immutable versions and transitions are event-provenanced', () => {
    const d=database(); const first=setWorkflow('test-flow',valid(),'first','author',d)
    const changed=valid();changed.title='Changed';const second=setWorkflow('test-flow',changed,'second','author',d)
    expect([first.n,second.n]).toEqual([1,2]); expect(showWorkflow('test-flow',1,d).definition.title).toBe('A workflow')
    promoteWorkflow('test-flow',1,'publish','architect',d)
    expect(()=>promoteWorkflow('test-flow',1,'again','architect',d)).toThrow('not a draft')
    promoteWorkflow('test-flow',2,'replace','architect',d)
    expect(showWorkflow('test-flow',1,d).status).toBe('retired');expect(showWorkflow('test-flow',2,d).status).toBe('production')
    retireWorkflow('test-flow',2,'withdraw','architect',d)
    const versions=workflowVersions('test-flow',d)
    expect(versions[1]!.events.map((e:any)=>e.event)).toEqual(['set','promote','retire'])
    expect(()=>setWorkflow('x',valid(),'','author',d)).toThrow('reason is required')
  })
  test('fork copies a selected version into a new draft',()=>{const d=database();setWorkflow('forked',valid(),'set','a',d);promoteWorkflow('forked',1,'go','a',d);const fork=forkWorkflow('forked',undefined,'revise','a',d);expect(fork.n).toBe(2);expect(fork.definition).toEqual(valid())})
  test('compose is lean and reports mode and argument needs',()=>{
    const d=database();setWorkflow('compose',valid(),'set','a',d)
    expect(()=>composeWorkflow('compose',undefined,{key:'DEV-257'},d)).toThrow('workflow "compose" has no production version; promote one')
    expect(()=>getWorkflowStep('compose','work',{key:'DEV-257'},d)).toThrow('workflow "compose" has no production version; promote one')
    promoteWorkflow('compose',1,'go','a',d)
    const composed=composeWorkflow('compose',undefined,{key:'DEV-257'},d);expect(composed.mode?.slug).toBe('default');expect(JSON.stringify(composed)).not.toContain('Work on')
    expect(composeWorkflow('compose',undefined,{},d).needs.arguments).toEqual(['key'])
    const noDefault=valid();delete noDefault.modes[0]!.default;noDefault.modes[0]!.entry='Which path?';setWorkflow('choose',noDefault,'set','a',d);promoteWorkflow('choose',1,'go','a',d)
    expect(composeWorkflow('choose',undefined,{key:'x'},d).needs.mode?.[0]?.entry).toBe('Which path?')
  })
  test('step fetch substitutes and requires arguments',()=>{const d=database();setWorkflow('stepper',valid(),'set','a',d);promoteWorkflow('stepper',1,'go','a',d);expect(getWorkflowStep('stepper','work',{key:'DEV-257'},d).body).toBe('Work on DEV-257.');expect(()=>getWorkflowStep('stepper','work',{},d)).toThrow('missing required arguments: key')})
})

describe('workflow projection and seeds', () => {
  const workflowId=(d:Database,slug:string)=>(d.query('SELECT id FROM workflow WHERE slug=?').get(slug) as {id:number}).id
  const events=(d:Database,slug:string)=>d.query('SELECT version_n,event,author,reason,session_id,at FROM workflow_event WHERE workflow_id=? ORDER BY id').all(workflowId(d,slug)) as {version_n:number,event:string,author:string,reason:string,session_id:string|null,at:string}[]
  const makeLegacy=(d:Database,slug:string,n:number,author='seed')=>{
    const id=workflowId(d,slug), definition=JSON.stringify(showWorkflow(slug,1,d).definition), at='2026-01-01T00:00:00.000Z'
    d.query('DELETE FROM workflow_event WHERE workflow_id=?').run(id);d.query('DELETE FROM workflow_version WHERE workflow_id=?').run(id)
    for(let version=1;version<=n;version++)d.query(`INSERT INTO workflow_version (workflow_id,n,status,definition,author,reason,created_at,promoted_at,retired_at) VALUES (?,?,?, ?,?,?,?, ?,?)`).run(id,version,version===n?'production':'retired',definition,version===n?author:'seed',version===1?'DEV-257 seed':'operator edit',at,version===n?at:null,version===n?null:at)
    d.query(`INSERT INTO workflow_event (workflow_id,version_n,event,author,reason,session_id,at) VALUES (?,1,'set','seed','DEV-257 seed',NULL,?)`).run(id,at)
    if(n>1)d.query(`INSERT INTO workflow_event (workflow_id,version_n,event,author,reason,session_id,at) VALUES (?,?,'set',?,'operator edit',NULL,?)`).run(id,n,author,at)
  }
  test('fresh stores seed revision 2 as production version 1',()=>{const d=database();expect(listWorkflows(d).filter((w)=>['ship','filed-issue'].includes(w.slug)).length).toBe(2);for(const slug of ['ship','filed-issue']){const version=showWorkflow(slug,1,d);expect(version.status).toBe('production');expect(version.author).toBe('seed');expect(version.reason).toBe('seed r2');expect(events(d,slug).map(({version_n,event,author,reason,session_id})=>({version_n,event,author,reason,session_id}))).toEqual([{version_n:1,event:'set',author:'seed',reason:'seed r2',session_id:null}]);expect(validateWorkflowDefinition(version.definition)).toEqual([])}})
  test('seed bodies describe pull-request admission and runnable review prompts',()=>{const d=database();const ship=showWorkflow('ship',1,d).definition,filed=showWorkflow('filed-issue',1,d).definition;expect(ship.modes[0]!.steps).toEqual(['rebase','lens','score','triage','complete','fix','pr','merge','close']);expect(filed.modes[0]!.steps).toEqual(['diagnose','fix','verify','blast-radius','triage','ship']);for(const definition of [ship,filed])for(const step of definition.steps){expect(step.body).not.toContain('orch land');if(step.body.includes('do review-lens'))expect(step.body).toMatch(/do review-lens[^\n]*"[^"]+"/)}const rebase=ship.steps.find((step)=>step.slug==='rebase')!.body;expect(rebase).toContain('git fetch origin');expect(rebase).toContain('git rebase origin/main');expect(rebase).toContain('repository root, `orchestrator/` and `hub/`');expect(rebase).toContain('ceiling baseline tightened');expect(ship.steps.find((step)=>step.slug==='pr')!.body).toContain('gh pr create --base main');expect(ship.steps.find((step)=>step.slug==='merge')!.body).toContain('gh pr merge <number> --squash --delete-branch');expect(ship.steps.find((step)=>step.slug==='close')!.body).toContain('Shipped in #<number>.');expect(filed.steps.find((step)=>step.slug==='blast-radius')!.body).toContain('the branch `orch result` prints');expect(filed.steps.find((step)=>step.slug==='ship')!.body).toBe('Ship the fix through the `ship` workflow: gate, pull request, merge.')})
  test('legacy seed revisions upgrade both live shapes',()=>{const d=database();makeLegacy(d,'ship',2,'operator');makeLegacy(d,'filed-issue',1);applySchema(d);expect(showWorkflow('ship',3,d).status).toBe('production');expect(showWorkflow('filed-issue',2,d).status).toBe('production');for(const [slug,prior,next] of [['ship',2,3],['filed-issue',1,2]] as const){expect(showWorkflow(slug,prior,d).status).toBe('retired');expect(showWorkflow(slug,next,d).reason).toBe('seed r2');expect(events(d,slug).slice(-3).map(({version_n,event,author,reason,session_id,at})=>({version_n,event,author,reason,session_id,at}))).toEqual([{version_n:prior,event:'retire',author:'seed',reason:'seed r2',session_id:null,at:expect.any(String)},{version_n:next,event:'set',author:'seed',reason:'seed r2',session_id:null,at:expect.any(String)},{version_n:next,event:'promote',author:'seed',reason:'seed r2',session_id:null,at:expect.any(String)}])}})
  test('revision seeding is idempotent',()=>{const d=database();makeLegacy(d,'ship',1);applySchema(d);applySchema(d);expect(workflowVersions('ship',d).map((version)=>version.n)).toEqual([1,2])})
  test('seed revision replaces but retains an operator production version',()=>{const d=database();makeLegacy(d,'ship',2,'architect');applySchema(d);expect(showWorkflow('ship',2,d).status).toBe('retired');expect(showWorkflow('ship',2,d).author).toBe('architect');expect(showWorkflow('ship',3,d).status).toBe('production');expect(showWorkflow('ship',3,d).author).toBe('seed')})
  test('a workflow with no production version upgrades without a retire event',()=>{const d=database();makeLegacy(d,'ship',1);d.query("UPDATE workflow_version SET status='retired',retired_at=? WHERE status='production'").run(new Date().toISOString());const before=events(d,'ship').length;applySchema(d);expect(showWorkflow('ship',2,d).status).toBe('production');expect(events(d,'ship').slice(before).map(({event})=>event)).toEqual(['set','promote'])})
  test('ship composes in order and retains the scoring vocabulary',()=>{const d=database();expect(composeWorkflow('ship','default',{key:'DEV-257',branch:'x',worktree:'/tmp/x'},d).steps.map((s)=>s.slug)).toEqual(['rebase','lens','score','triage','complete','fix','pr','merge','close']);const score=getWorkflowStep('ship','score',{key:'DEV-257',branch:'x',worktree:'/tmp/x'},d).body;for(const vocabulary of [REVIEW_REPRODUCED,REVIEW_COVERAGE,REVIEW_LIMITS,REVIEW_OVERLAP])expect(score).toContain(`<${vocabulary.join('|')}>`);expect(score).toContain('Grading records the lens on the review');expect(score).toContain('no separate record step')})
  test('export is byte-identical and import writes drafts',()=>{const d=database();const dir=mkdtempSync(join(tmpdir(),'workflow-export-'));temps.push(dir);exportWorkflows(dir,d);const snapshot=(root:string)=>readdirSync(root,{recursive:true}).filter((p)=>statSync(join(root,String(p))).isFile()).sort().map((p)=>[p,readFileSync(join(root,String(p)),'utf8')]);const once=snapshot(dir);exportWorkflows(dir,d);expect(snapshot(dir)).toEqual(once);const target=database();importWorkflows(dir,'round trip','a',target);expect(showWorkflow('ship',2,target).status).toBe('draft')})
})

describe('workflow CLI', () => {
  test('JSON surfaces compose leanly and exit 2 when choices or arguments are needed',()=>{
    const dir=mkdtempSync(join(tmpdir(),'workflow-cli-'));temps.push(dir)
    const databasePath=join(dir,'orch.db'), definitionPath=join(dir,'choose.json')
    const definition=valid();delete definition.modes[0]!.default;definition.modes[0]!.entry='Choose this mode?'
    writeFileSync(definitionPath,JSON.stringify(definition))
    const cli=new URL('./cli.ts',import.meta.url).pathname
    const run=(args:string[])=>{const p=Bun.spawnSync([process.execPath,cli,...args],{env:{...process.env,ORCH_DB:databasePath},stdout:'pipe',stderr:'pipe'});return {code:p.exitCode,out:p.stdout.toString(),err:p.stderr.toString()}}
    bootstrapFixtureStore(databasePath)
    expect(run(['workflow','set','choose','--file',definitionPath,'--reason','create']).code).toBe(0)
    expect(run(['workflow','promote','choose','1','--reason','publish']).code).toBe(0)
    const needs=run(['workflow','compose','choose','--json']);expect(needs.code).toBe(2);expect(JSON.parse(needs.out).needs).toEqual({mode:[{slug:'default',title:'Default',entry:'Choose this mode?'}],arguments:['key']})
    const composed=run(['workflow','compose','choose','--mode','default','--arg','key=DEV-257','--json']);expect(composed.code).toBe(0);expect(composed.out).not.toContain('Work on')
    const step=run(['workflow','step','choose','work','--arg','key=DEV-257','--json']);expect(JSON.parse(step.out).body).toBe('Work on DEV-257.')
    expect(JSON.parse(run(['workflow','list','--json']).out).some((row:any)=>row.slug==='ship')).toBe(true)
  }, 20_000)
})
