// concern: ruling-file
/** Renders filed ruling text, titles, slugs, and the operator file-offer hint. */

function yamlLiteral(value: string): string {
  return `|\n${value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`
}

export function renderRulingFileText(input: {
  question: string
  ruling: string
  answererKind: string | null
  runId: number | null
  workflow?: { slug: string; mode: string; cursorId: number } | null
  taskKey: string | null
  date: string
  questionId: number
}): string {
  return [
    '---',
    `question_id: ${input.questionId}`,
    ...(input.runId === null && input.workflow
      ? [
          `workflow: ${input.workflow.slug}`,
          `workflow_mode: ${input.workflow.mode}`,
          `workflow_cursor: ${input.workflow.cursorId}`,
        ]
      : [`run: ${input.runId}`]),
    `task: ${input.taskKey ?? 'none'}`,
    `date: ${input.date}`,
    `answerer: ${input.answererKind ?? 'unknown'}`,
    `question: ${yamlLiteral(input.question)}`,
    `ruling: ${yamlLiteral(input.ruling)}`,
    '---',
    '',
    'The recorded ruling is filed for demand delivery.',
  ].join('\n')
}

export function renderCanonProposalNote(text: string): string {
  return `Canon proposal: ${text.replaceAll('\n', ' / ')}`
}

export function shortRulingTitle(question: string): string {
  const line = question.trim().split('\n', 1)[0]?.trim() ?? ''
  if (!line) return 'Ruling'
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line
}

export function rulingDocSlug(title: string, questionId: number): string {
  const suffix = `-q${questionId}`
  const budget = Math.max(1, 64 - suffix.length)
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, budget)
    .replace(/-+$/g, '')
  return `${base || 'ruling'}${suffix}`.slice(0, 64)
}

export function rulingFileHint(questionId: number): string {
  return `File this ruling: orch ruling file ${questionId} --as doc|canon`
}

export function operatorAttributedRuling(input: {
  fromOperator: boolean
  channel?: string
}): boolean {
  return input.fromOperator || input.channel === 'ui'
}

export function rulingFileOfferLines(input: {
  questionIds: readonly number[]
  operatorAttributed: boolean
  json: boolean
}): string[] {
  if (input.json || !input.operatorAttributed) return []
  return input.questionIds.map(rulingFileHint)
}

export function filedDocRef(id: number, revision: string | null): string {
  return revision ? `${id}@${revision}` : String(id)
}
