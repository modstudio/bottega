// concern: answer-value-args
/** Decodes the CLI's typed answer value against the selected stored question kind. */

import { db } from '../database/db.ts'
import { resolveQuestionIdentifier } from './question-identifier.ts'
import { questionOpenSql } from './question-open.ts'

export type AnswerValueArgs = {
  argv: string[]
  questionId?: string
  value?: string | boolean | number
}

function takeValue(argv: string[]): { argv: string[]; raw?: string } {
  const remaining: string[] = []
  let raw: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument !== '--value' && !argument.startsWith('--value=')) {
      remaining.push(argument)
      continue
    }
    if (raw !== undefined) throw new Error('--value may be supplied only once')
    raw = argument === '--value' ? argv[++index] : argument.slice('--value='.length)
    if (!raw) throw new Error('--value needs a value')
  }
  return { argv: remaining, raw }
}

function selectedQuestion(answerId: string, identifiers: string[]): string {
  if (identifiers.length > 1) throw new Error('--value may answer only one question at a time')
  if (identifiers.length) return resolveQuestionIdentifier(db(), identifiers[0]!)
  const open = db()
    .query<{ record_id: string }, [string, string]>(
      `SELECT q.record_id FROM question q JOIN run r ON r.record_id=q.run_record_id
        WHERE (r.record_id=? OR r.parent_run_record_id=?) AND ${questionOpenSql('q')}
        ORDER BY q.number`,
    )
    .all(answerId, answerId)
  if (open.length > 1)
    throw new Error('--value requires --q<id> when more than one question is open')
  if (!open[0]) throw new Error('--value names no open question')
  return open[0].record_id
}

function decodedValue(kind: string, raw: string): string | boolean | number {
  if (kind === 'yesno') {
    const normalized = raw.toLowerCase()
    if (normalized !== 'true' && normalized !== 'false')
      throw new Error('--value for a yesno question must be true or false')
    return normalized === 'true'
  }
  if (kind === 'score') {
    if (!/^-?\d+$/.test(raw)) throw new Error('--value for a score question must be an integer')
    return Number(raw)
  }
  return raw
}

export function answerValueArgs(
  argv: string[],
  answerId: string | undefined,
  questionIdentifiers: string[],
): AnswerValueArgs {
  const taken = takeValue(argv)
  if (taken.raw === undefined) return { argv: taken.argv }
  if (!answerId) throw new Error('--value requires a question context')
  const questionId = selectedQuestion(answerId, questionIdentifiers)
  const stored = db()
    .query<{ kind: string }, [string]>('SELECT kind FROM question WHERE record_id=?')
    .get(questionId)
  if (!stored) throw new Error('--value names no question')
  return { argv: taken.argv, questionId, value: decodedValue(stored.kind, taken.raw) }
}
