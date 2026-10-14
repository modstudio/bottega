// concern: ratchet-cli
/** Owns only the `bottega gate ratchet` grammar and presentation. */

import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { runRatchet } from '../ratchet/ratchet-service.ts'

const USAGE =
  `usage: ${PLATFORM_SLUG} gate ratchet --format <name> [--staged|--base <ref>] [--support <path>]... <command...>\n` +
  `   or: ${PLATFORM_SLUG} gate ratchet --format <phpcs|phpstan> --head-report <file> --base-report <file> [--staged|--base <ref>] [--report-root <path>] [--measure <rule>=<pattern>]...`

function measure(value: string, previous: { rule: string; pattern: string }[]) {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--measure must be <rule>=<pattern>\n${USAGE}`)
  }
  return [...previous, { rule: value.slice(0, separator), pattern: value.slice(separator + 1) }]
}

export function register(program: Command): void {
  program
    .command('ratchet')
    .requiredOption('--format <name>')
    .option('--staged')
    .option('--base <ref>')
    .option('--support <path>', '', (value, previous: string[]) => [...previous, value], [])
    .option('--head-report <file>')
    .option('--base-report <file>')
    .option('--report-root <path>')
    .option('--measure <rule=pattern>', '', measure, [])
    .argument('[command...]')
    .allowUnknownOption(true)
    .action(async (command, options) => {
      if (options.staged && options.base) throw new Error('--staged cannot be combined with --base')
      const reportFlag =
        options.headReport || options.baseReport || options.reportRoot || options.measure.length > 0
      if (reportFlag) {
        if (
          !options.headReport ||
          !options.baseReport ||
          command.length > 0 ||
          options.support.length > 0
        ) {
          throw new Error(USAGE)
        }
      } else if (command.length === 0) {
        throw new Error(USAGE)
      }
      const passed = await runRatchet({
        cwd: process.cwd(),
        format: options.format,
        staged: Boolean(options.staged),
        base: options.base,
        support: options.support,
        command,
        headReport: options.headReport,
        baseReport: options.baseReport,
        reportRoot: options.reportRoot,
        measures: options.measure,
      })
      if (!passed) process.exitCode = 1
    })
}
