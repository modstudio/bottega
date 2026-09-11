/** Vendor stand-in scripts shared by process-boundary tests. */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from './fixture.ts'

export function stubWorker(opts: {
  commits?: boolean
  commands?: string[]
  sleepSeconds?: number
  burnCpu?: boolean
  exitCode?: number
} = {}): string {
  const root = mkdtempSync(join(dir, 'stub-worker-'))
  const script = join(root, 'worker.sh')
  const lines = ['#!/bin/sh', 'set -e']
  lines.push(
    '[ -z "$ORCH_STUB_PID_FILE" ] || echo "$$" > "$ORCH_STUB_PID_FILE"',
    'case " $* " in *" mcp doctor "*) [ -z "$ORCH_STUB_MCP_DOCTOR_OUTPUT" ] || { printf "%s" "$ORCH_STUB_MCP_DOCTOR_OUTPUT"; exit 0; } ;; esac',
    '[ -z "$ORCH_STUB_REPLY" ] || printf "%s" "$ORCH_STUB_REPLY" > "$ORCH_SCRATCH/reply.json"',
    '[ -z "$ORCH_STUB_OUTPUT" ] || printf "%s\\n" "$ORCH_STUB_OUTPUT"',
    '[ -z "$ORCH_STUB_READY_FILE" ] || printf "ready\\n" > "$ORCH_STUB_READY_FILE"',
  )
  if (opts.commands) lines.push(...opts.commands)
  if (opts.commits) {
    lines.push(
      'echo worker > worker.txt',
      'git add worker.txt',
      'git commit -m "DEV-389 worker commit" >/dev/null',
      'echo dirty >> file.txt',
    )
  }
  if (opts.burnCpu) lines.push('while :; do :; done')
  if (opts.sleepSeconds !== undefined) lines.push(
    'sleep ' + opts.sleepSeconds + ' &',
    'child=$!',
    '[ -z "$ORCH_STUB_CHILD_PID_FILE" ] || echo "$child" > "$ORCH_STUB_CHILD_PID_FILE"',
    'wait',
  )
  lines.push('exit ' + (opts.exitCode ?? 0))
  writeFileSync(script, lines.join('\n') + '\n')
  chmodSync(script, 0o755)
  return script
}
