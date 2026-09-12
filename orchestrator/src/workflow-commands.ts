// concern: workflows
/** Owns workflow command decisions and presentation. Must not know CLI grammar. */
import { readFileSync } from 'node:fs'
import { flagValue, flagValues } from './args.ts'
import { composeWorkflow, exportWorkflows, forkWorkflow, getWorkflowStep, importWorkflows, listWorkflows, promoteWorkflow, retireWorkflow, setWorkflow, showWorkflow, workflowVersions } from './workflows.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }
const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export function workflowCommand(argv: string[], presentation: Presentation): void {
  const sub = argv[1]; const json = argv.includes('--json')
  const flag = (name: string) => flagValue(argv, name)
  const print = (value: unknown, line?: string) => presentation.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
  if (sub === 'list') { const rows = listWorkflows(); print(rows, rows.map((row) => `${row.slug}  ${row.title}  production=${row.production_n ?? '-'} draft=${row.draft_n ?? '-'}`).join('\n')) }
  else if (sub === 'show') print(showWorkflow(argv[2]!, positive(flag('version'), '--version')))
  else if (sub === 'set') { const file = flag('file'); if (!file) throw new Error('file is required'); print(setWorkflow(argv[2]!, JSON.parse(readFileSync(file, 'utf8')), flag('reason'), flag('author'))) }
  else if (sub === 'promote') print(promoteWorkflow(argv[2]!, positive(argv[3], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'retire') print(retireWorkflow(argv[2]!, positive(argv[3], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'fork') print(forkWorkflow(argv[2]!, positive(flag('from'), '--from'), flag('reason'), flag('author')))
  else if (sub === 'versions') print(workflowVersions(argv[2]!))
  else if (sub === 'compose') composeCommand(argv, json, print, presentation)
  else if (sub === 'step') { const step = getWorkflowStep(argv[2]!, argv[3]!, workflowArgs(argv)); print(step, step.body) }
  else if (sub === 'export') exportWorkflows(argv[2]!)
  else if (sub === 'import') print(importWorkflows(argv[2]!, flag('reason'), flag('author')))
  else throw new Error('unknown: orch workflow. Try list | show | set | promote | retire | fork | versions | compose | step | export | import')
}

function workflowArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(flagValues(argv, 'arg').map((pair) => { const at = pair.indexOf('='); if (at < 1) throw new Error(`invalid --arg "${pair}"; use k=v`); return [pair.slice(0, at), pair.slice(at + 1)] }))
}

function composeCommand(argv: string[], json: boolean, print: (value: unknown, line?: string) => void, presentation: Presentation): void {
  const result = composeWorkflow(argv[2]!, flagValue(argv, 'mode'), workflowArgs(argv))
  print(result, json ? undefined : [`${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`, ...(result.needs.mode ?? []).map((mode) => `${mode.slug}: ${mode.entry}`), ...(result.needs.arguments ? [`missing required arguments: ${result.needs.arguments.join(', ')}`] : []), ...result.steps.map((step) => `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy} gate=${step.gate ?? '-'}]`)].join('\n'))
  if (Object.keys(result.needs).length) presentation.setExitCode(2)
}
