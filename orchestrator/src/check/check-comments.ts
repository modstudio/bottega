import { DEFAULT_COMMENT_HISTORY_PHRASES } from '../canon/prose-lint.ts'

export type CommentSource = {
  file: string
  line: number
  text: string
}

export type CommentRules = {
  taskKeyPrefixes?: readonly string[]
  historyPhrases?: readonly string[]
}

export type CommentFinding = {
  file: string
  line: number
  rule: 'task-key' | 'history' | 'history-allow'
  match: string
  comment: string
}

export { DEFAULT_COMMENT_HISTORY_PHRASES }

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchLine(startLine: number, text: string, index: number): number {
  return startLine + text.slice(0, index).split('\n').length - 1
}

function historyMarker(comment: string): 'absent' | 'empty' | 'allowed' {
  let found = false
  for (const match of comment.matchAll(/history-ok:[^\S\r\n]*([^\r\n]*)/gi)) {
    found = true
    const reason = match[1]!.replace(/\*\/\s*$/, '').trim()
    if (reason) return 'allowed'
  }
  return found ? 'empty' : 'absent'
}

export function commentTaskKeyRefusal(
  enabled: boolean,
  project: string,
  prefixes: readonly string[] | undefined,
): string | null {
  if (!enabled || prefixes?.some((prefix) => prefix.trim())) return null
  return `checks.commentTaskKeys for ${project} requires keyPrefixes; set them with: orch project set ${project} --settings '{"keyPrefixes":["<PREFIX>"]}'`
}

/** Findings are a pure decision over one extracted comment and supplied rules. */
export function commentFindings(comment: CommentSource, rules: CommentRules): CommentFinding[] {
  const findings: CommentFinding[] = []
  const prefixes = rules.taskKeyPrefixes?.filter(Boolean) ?? []
  if (prefixes.length) {
    const taskKey = new RegExp(
      `(?<![A-Za-z0-9])(?:${prefixes.map(escaped).join('|')})-\\d+\\b`,
      'g',
    )
    for (const match of comment.text.matchAll(taskKey)) {
      findings.push({
        file: comment.file,
        line: matchLine(comment.line, comment.text, match.index),
        rule: 'task-key',
        match: match[0],
        comment: comment.text,
      })
    }
  }

  const phrases = rules.historyPhrases ?? []
  if (!phrases.length) return findings
  const marker = historyMarker(comment.text)
  if (marker === 'allowed') return findings
  if (marker === 'empty') {
    const index = comment.text.search(/history-ok:/i)
    findings.push({
      file: comment.file,
      line: matchLine(comment.line, comment.text, index),
      rule: 'history-allow',
      match: 'history-ok:',
      comment: comment.text,
    })
    return findings
  }

  for (const phrase of phrases.filter(Boolean)) {
    const phrasePattern = phrase.trim().split(/\s+/).map(escaped).join('\\s+')
    const pattern = new RegExp(`\\b${phrasePattern}\\b`, 'gi')
    for (const match of comment.text.matchAll(pattern)) {
      findings.push({
        file: comment.file,
        line: matchLine(comment.line, comment.text, match.index),
        rule: 'history',
        match: match[0],
        comment: comment.text,
      })
    }
  }
  return findings
}

export function formatCommentFinding(finding: CommentFinding): string {
  const match = finding.match.replace(/\s+/g, ' ')
  if (finding.rule === 'task-key') {
    return `${finding.file}:${finding.line}: task key in comment: ${match}`
  }
  if (finding.rule === 'history-allow') {
    return `${finding.file}:${finding.line}: history-ok: requires a non-empty reason`
  }
  return `${finding.file}:${finding.line}: history phrase in comment: ${match}`
}
