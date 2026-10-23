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
import { db } from '../database/db.ts'
import { getDocRevision, setDoc } from '../doc/docs.ts'
import { fileNote } from '../mcp/hub-notes.ts'
import { questionIdentityMap, resolveQuestionIdentifier } from '../run/question-identifier.ts'
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
    const revision = doc.revision ? getDocRevision(doc.revision) : null
    if (!revision) throw new Error('filed ruling document has no revision')
    return { id: doc.record_id, revision: revision.record_id, revisionNumber: revision.number }
  },
  fileNote,
}

function registerQuestionIdentities(program: Command): void {
  program
    .command('question-identities')
    .description('print numeric question identities and their durable record ids as JSON')
    .allowExcessArguments(false)
    .action(() => log(JSON.stringify(questionIdentityMap(db()))))
}

export function register(program: Command): void {
  registerQuestionIdentities(program)
  const question = program.command('question').description('manage worker questions')
  question
    .command('close <id>')
    .description('close a question without recording a ruling')
    .requiredOption('--reason <text>', 'record why the question is closed')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const questionId = resolveQuestionIdentifier(db(), id)
      const { closeQuestionByOperator } = await import('../run/question-close.ts')
      closeQuestionByOperator(questionId, requiredText(options.reason, '--reason'))
      log(`closed question ${questionId}`)
    })
  const ruling = program.command('ruling').description('inspect and preserve recorded rulings')
  ruling
    .command('list')
    .description('list recorded run and workflow rulings')
    .option('--since <ISO>', 'include ruling activity since this instant')
    .option('--kind <kind>', 'workflow, run, or all', 'all')
    .option('--json', 'write the rulings as JSON')
    .allowExcessArguments(false)
    .action((options) => {
      if (!['workflow', 'run', 'all'].includes(options.kind))
        throw new Error('--kind must be workflow, run, or all')
      log(JSON.stringify(listRulings({ since: options.since, kind: options.kind })))
    })
  ruling
    .command('overturn <question-id>')
    .description('overturn a recorded ruling')
    .requiredOption('--because <reason>', 'record why the ruling is overturned')
    .option('--replacement <ruling>', 'record this replacement ruling')
    .option('--replacement-file <path>', 'read the replacement ruling from this file')
    .option('--from-operator', 'attribute the overturn to the operator')
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
        questionId: resolveQuestionIdentifier(db(), questionId),
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
    .description('file a recorded ruling as a document or canon proposal')
    .requiredOption('--as <kind>', 'file the ruling as doc or canon')
    .option('--scope <doc-scope>', 'file the document in this scope')
    .option('--subject <subject>', 'file the document under this subject')
    .option('--title <title>', 'use this document title')
    .option('--from-operator', 'attribute the filing to the operator')
    .option('--channel <channel>', 'record the channel that requested the filing')
    .option('--json', 'write the filing result as JSON')
    .allowExcessArguments(false)
    .action(async (questionId, options) => {
      const result = await fileRuling(
        {
          questionId: resolveQuestionIdentifier(db(), questionId),
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
      else {
        const shown = result.filed_label ?? result.filed_ref
        const identity = result.filed_record_id ? ` (${result.filed_record_id})` : ''
        log(`filed as ${result.filed_as} at ${shown}${identity}`)
      }
    })
}
