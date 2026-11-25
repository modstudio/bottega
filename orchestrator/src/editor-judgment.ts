export type EditorJudgment = {
  status: 'ok' | 'refused' | 'unchecked'
  findings: { rule: string; dependency: string }[]
  reason?: string
}
