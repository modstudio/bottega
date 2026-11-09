#!/usr/bin/env bun
import { STATE_CLASS_OUTBOX_TABLES } from './identity-state-class-facts.ts'
import { HOSTED_WRITE_PATHS, hostedWritePathReport } from './identity-state-class-report.ts'
import { STATE_CLASSES } from './identity-state-classes.ts'

const report = hostedWritePathReport(STATE_CLASSES, STATE_CLASS_OUTBOX_TABLES)

if (Bun.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const path of HOSTED_WRITE_PATHS) {
    console.log(`${path}: ${report.counts[path]}`)
    for (const table of report.paths[path]) console.log(`  ${table}`)
  }
}
