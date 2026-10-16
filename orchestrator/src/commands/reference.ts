// concern: cli
/** Registers generated reference publication without owning document behavior. */
import type { Command } from 'commander'
import { publishReferenceDocs } from '../doc/reference-publish.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  program
    .command('reference')
    .description('manage generated reference documents')
    .command('publish')
    .description('publish tracked generated command-reference pages')
    .action(async () => {
      for (const result of await publishReferenceDocs(process.cwd()))
        log(`${result.slug}: ${result.disposition}`)
    })
}
