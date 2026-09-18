import type { Project } from '../project/projects.ts'

export type FiledIssue = {
  key: string
  title: string
  kind: 'defect' | 'suggestion'
  reportingProject: string
  whatHappened: string
  expected: string
  reproduceCommand: string | null
  environment: string | null
  evidence: string
  notEstablished: string
}

type FiledIssueData = {
  version: 1
  kind: 'defect' | 'suggestion'
  reporting_project: string
  submitted_title: string | null
  what_happened: string
  expected: string
  reproduce_command: string | null
  environment: string | null
  evidence: string
  not_established: string
}

const FILED_ISSUE_DATA_PREFIX = 'FILED ISSUE DATA: '

export function filedIssueDataLine(data: FiledIssueData): string {
  return `${FILED_ISSUE_DATA_PREFIX}${JSON.stringify(data)}`
}

function section(body: string, heading: string, next: string[], boundary: number): string {
  const parsedBody = body.slice(0, boundary)
  const start = parsedBody.indexOf(`${heading}\n`)
  if (start < 0) return ''
  const from = start + heading.length + 1
  const ends = next.map((h) => parsedBody.indexOf(`\n\n${h}\n`, from)).filter((n) => n >= 0)
  return parsedBody.slice(from, ends.length ? Math.min(...ends) : undefined).trim()
}

function filedIssueTask(shown: unknown): { key: string; body: string; title: string } {
  const task =
    shown &&
    typeof shown === 'object' &&
    'task' in shown &&
    shown.task &&
    typeof shown.task === 'object'
      ? shown.task
      : null
  if (
    !task ||
    !('key' in task) ||
    typeof task.key !== 'string' ||
    !('body' in task) ||
    typeof task.body !== 'string'
  ) {
    throw new Error('filed issue is missing its task body')
  }
  return {
    key: task.key as string,
    body: task.body as string,
    title: 'title' in task && typeof task.title === 'string' ? task.title : '',
  }
}

export function parseFiledIssue(shown: unknown): FiledIssue {
  const task = filedIssueTask(shown)
  const body = task.body
  const title = task.title
  if (body.startsWith(FILED_ISSUE_DATA_PREFIX)) {
    const lineEnd = body.indexOf('\n')
    const encoded = body.slice(FILED_ISSUE_DATA_PREFIX.length, lineEnd < 0 ? undefined : lineEnd)
    let data: unknown
    try {
      data = JSON.parse(encoded)
    } catch {
      throw new Error(`${task.key} has invalid filed issue data`)
    }
    const value = data as Partial<FiledIssueData> | null
    const kind = value?.kind
    const required = [
      value?.reporting_project,
      value?.what_happened,
      value?.expected,
      value?.evidence,
      value?.not_established,
    ]
    const optional = [value?.submitted_title, value?.reproduce_command, value?.environment]
    if (
      value?.version !== 1 ||
      (kind !== 'defect' && kind !== 'suggestion') ||
      required.some((field) => typeof field !== 'string') ||
      optional.some((field) => field !== null && typeof field !== 'string')
    ) {
      throw new Error(`${task.key} has invalid filed issue data`)
    }
    return {
      key: task.key,
      title,
      kind,
      reportingProject: value.reporting_project!,
      whatHappened: value.what_happened!,
      expected: value.expected!,
      reproduceCommand: value.reproduce_command!,
      environment: value.environment!,
      evidence: value.evidence!,
      notEstablished: value.not_established!,
    }
  }
  const kind = body.match(/^TYPE: (DEFECT|SUGGESTION)$/m)?.[1]?.toLowerCase()
  const reportingProject = body.match(/^REPORTING PROJECT: (.+)$/m)?.[1]?.trim()
  if ((kind !== 'defect' && kind !== 'suggestion') || !reportingProject) {
    throw new Error(`${task.key} is not a filed issue: TYPE and REPORTING PROJECT are required`)
  }
  const lengthRecord = body.match(/\n\nFILED FIELDS LENGTH: ([0-9]+)$/)
  const recordedBoundary = lengthRecord ? Number(lengthRecord[1]) : -1
  const submittedTitle = body.lastIndexOf('\n\nSUBMITTED TITLE\n')
  const parsedBoundary =
    recordedBoundary >= 0 && recordedBoundary <= (lengthRecord?.index ?? -1)
      ? recordedBoundary
      : submittedTitle < 0
        ? body.length
        : submittedTitle
  const headings = ['EXPECTED INSTEAD', 'HOW TO REPRODUCE', 'EVIDENCE', 'WHAT IS NOT ESTABLISHED']
  const how = section(
    body,
    'HOW TO REPRODUCE',
    ['EVIDENCE', 'WHAT IS NOT ESTABLISHED'],
    parsedBoundary,
  )
  const command = how.match(/^Command: ([\s\S]*?)(?:\nEnvironment:|$)/)?.[1]?.trim() ?? null
  const environment = how.match(/(?:^|\n)Environment: ([\s\S]*)$/)?.[1]?.trim() ?? null
  return {
    key: task.key,
    title,
    kind,
    reportingProject,
    whatHappened: section(body, 'WHAT HAPPENED', headings, parsedBoundary),
    expected: section(body, 'EXPECTED INSTEAD', headings.slice(1), parsedBoundary),
    reproduceCommand: command,
    environment,
    evidence: section(body, 'EVIDENCE', ['WHAT IS NOT ESTABLISHED'], parsedBoundary),
    notEstablished: section(body, 'WHAT IS NOT ESTABLISHED', [], parsedBoundary),
  }
}

/** A stated seed is evidence only when exactly one registered spelling occurs. */
export function seedFromReport(project: Project, environment: string | null): string | null {
  const seeds = project.settings.worktree?.seeds ?? []
  if (!seeds.length) return null
  const text = environment ?? ''
  const named = seeds.filter((seed) => text.includes(seed))
  return named.length === 1 ? named[0]! : null
}

/** The latest exact, registered seed answer wins; invalid answers do not erase valid ones. */
export function seedAnswer(seeds: string[], comments: string[]): string | null {
  let answer: string | null = null
  for (const comment of comments) {
    const value = comment.match(/^Seed: (.+)$/)?.[1]
    if (value && seeds.includes(value)) answer = value
  }
  return answer
}

export function boundedIssuePack(issue: FiledIssue): string {
  return JSON.stringify(
    {
      key: issue.key,
      title: issue.title,
      kind: issue.kind,
      reporting_project: issue.reportingProject,
      what_happened: issue.whatHappened,
      expected: issue.expected,
      reproduce_command: issue.reproduceCommand,
      environment: issue.environment,
      evidence: issue.evidence,
      not_established: issue.notEstablished,
    },
    null,
    2,
  )
}
