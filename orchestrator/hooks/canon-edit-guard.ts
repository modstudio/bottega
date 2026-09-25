#!/usr/bin/env bun
import { CANON_COMPACT_MATCHER } from '../src/canon/canon-edit-guard.ts'
// concern: canon-edit-guard-hook
/** Wires hook stdin and stdout to the in-process canon edit handler. */
import { handleCanonEditHook } from '../src/canon/canon-edit-hook-handler.ts'

const outcome = await handleCanonEditHook({
  payload: await Bun.stdin.text(),
  compact: process.argv.includes(CANON_COMPACT_MATCHER),
  projectRoot: process.env.CLAUDE_PROJECT_DIR,
  ports: async () => (await import('../src/canon/canon-edit-hook-ports.ts')).canonEditHookPorts,
})
if (outcome.warning) console.error(outcome.warning)
if (outcome.stdout) console.log(outcome.stdout)
