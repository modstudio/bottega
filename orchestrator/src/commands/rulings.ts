// concern: cli
/** Registers ruling mutation adapters and validates file-backed text. */

import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { FILING_DOC_SCOPES, type FilingDocScope } from '../../../shared/docs.ts'
import {
  ANSWER_CHANNEL_CLI,
  ANSWER_CHANNEL_VALUES,
  type AnswerChannel,
} from '../../../shared/question-vocabulary.ts'
import { setDoc } from '../doc/docs.ts'
import { fileNote } from '../mcp/hub-notes.ts'
import { fileRuling, type RulingFileStores } from '../run/ruling-file.ts'
import { operatorAttributedRuling, rulingFileOfferLines } from '../run/ruling-file-text.ts'
import { listRulings } from '../run/ruling-list.ts'
import { overturnRuling } from '../run/ruling-overturn.ts'
import { log } from './support.ts'

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`)
  return value
}

function rulingFileAs(value: string): 'doc' | 'canon' {
  if (value !== 'doc' && value !== 'canon') throw new Error('--as must be doc or canon')
  return value
}

function filingScope(value: string | undefined): FilingDocScope | undefined {
  if (value === undefined) return undefined
  if (!(FILING_DOC_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`--scope must be one of: ${FILING_DOC_SCOPES.join(', ')}`)
  }
  return value as FilingDocScope
}

function filingChannel(value: string | undefined): AnswerChannel {
  const channel = value ?? ANSWER_CHANNEL_CLI
  if (!ANSWER_CHANNEL_VALUES.includes(channel as AnswerChannel)) {
    throw new Error(`--channel must be one of: ${ANSWER_CHANNEL_VALUES.join(', ')}`)
  }
  return channel as AnswerChannel
}

const rulingFileStores: RulingFileStores = {
  writeDoc: async (input) => {
    const doc = await setDoc(input)
    return { id: doc.id, revision: doc.revision }
  },
  fileNote,
}

export function register(program: Command): void {
  const question = program.command('question')
  question
    .command('close <id>')
    .requiredOption('--reason <text>')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const questionId = Number(id)
      if (!Number.isSafeInteger(questionId) || questionId <= 0) {
        throw new Error('question id must be a positive integer')
      }
      const { closeQuestionByOperator } = await import('../run/question-close.ts')
      closeQuestionByOperator(questionId, requiredText(options.reason, '--reason'))
      log(`closed question ${questionId}`)
    })
  const ruling = program.command('ruling')
  ruling
    .command('list')
    .option('--since <ISO>')
    .option('--kind <kind>', 'workflow, run, or all', 'all')
    .requiredOption('--json')
    .allowExcessArguments(false)
    .action((options) => {
      if (!['workflow', 'run', 'all'].includes(options.kind))
        throw new Error('--kind must be workflow, run, or all')
      log(JSON.stringify(listRulings({ since: options.since, kind: options.kind })))
    })
  ruling
    .command('overturn <question-id>')
    .requiredOption('--because <reason>')
    .option('--replacement <ruling>')
    .option('--replacement-file <path>')
    .option('--from-operator')
    .allowExcessArguments(false)
    .action((questionId, options) => {
      if (options.replacement !== undefined && options.replacementFile !== undefined) {
        throw new Error(
          'pass a replacement with either --replacement or --replacement-file, not both',
        )
      }
      const replacement =
        options.replacementFile === undefined
          ? (options.replacement ?? null)
          : readFileSync(options.replacementFile, 'utf8')
      const result = overturnRuling({
        questionId: Number(questionId),
        reason: requiredText(options.because, '--because'),
        replacement: replacement === null ? null : requiredText(replacement, 'replacement'),
        fromOperator: Boolean(options.fromOperator),
      })
      for (const line of rulingFileOfferLines({
        questionIds: [result.question_id],
        operatorAttributed: operatorAttributedRuling({
          fromOperator: Boolean(options.fromOperator),
        }),
        json: false,
      })) {
        log(line)
      }
    })
  ruling
    .command('file <question-id>')
    .requiredOption('--as <kind>')
    .option('--scope <doc-scope>')
    .option('--subject <subject>')
    .option('--title <title>')
    .option('--from-operator')
    .option('--channel <channel>')
    .option('--json')
    .allowExcessArguments(false)
    .action(async (questionId, options) => {
      const result = await fileRuling(
        {
          questionId: Number(questionId),
          as: rulingFileAs(options.as),
          scope: filingScope(options.scope),
          subject: options.subject,
          title: options.title,
          fromOperator: Boolean(options.fromOperator),
          channel: filingChannel(options.channel),
        },
        rulingFileStores,
      )
      if (options.json) log(JSON.stringify(result))
      else log(`filed as ${result.filed_as} at ${result.filed_ref}`)
    })
}
