// concern: cli
/** Registers ruling mutation adapters and validates file-backed text. */

import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { overturnRuling } from '../run/ruling-overturn.ts'

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`)
  return value
}

export function register(program: Command): void {
  const ruling = program.command('ruling')
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
      overturnRuling({
        questionId: Number(questionId),
        reason: requiredText(options.because, '--because'),
        replacement: replacement === null ? null : requiredText(replacement, 'replacement'),
        fromOperator: Boolean(options.fromOperator),
      })
    })
}
