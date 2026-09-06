import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applySchema, bootstrapFixtureStore, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP,
  REVIEW_REPRODUCED } from './db.ts'
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
  test('seeds are idempotent, valid, and ship composes in order',()=>{const d=database();applySchema(d);expect(listWorkflows(d).filter((w)=>['ship','filed-issue'].includes(w.slug)).length).toBe(2);for(const slug of ['ship','filed-issue'])expect(validateWorkflowDefinition(showWorkflow(slug,1,d).definition)).toEqual([]);expect(workflowVersions('ship',d)[0]!.events.map((event:any)=>event.event)).toEqual(['set']);expect(composeWorkflow('ship','default',{key:'DEV-257',branch:'x',worktree:'/tmp/x'},d).steps.map((s)=>s.slug)).toEqual(['rebase','lens','score','triage','complete','fix','land','close']);const score=getWorkflowStep('ship','score',{key:'DEV-257',branch:'x',worktree:'/tmp/x'},d).body;for(const vocabulary of [REVIEW_REPRODUCED,REVIEW_COVERAGE,REVIEW_LIMITS,REVIEW_OVERLAP])expect(score).toContain(`<${vocabulary.join('|')}>`);expect(score).toContain('Grading records the lens on the review');expect(score).toContain('no separate record step')})
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
