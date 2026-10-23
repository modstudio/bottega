/** Builds a throwaway board store and fake board command for the board hook tests. */
import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  BOARD_PRESENCE_REFRESH_SECONDS,
  BOARD_PUSH_REFRESH_SECONDS,
} from '../../src/board/board-delivery.ts'

const hookRoots: string[] = []

export function removeHookFixtures() {
  for (const root of hookRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function createHookFixture(
  commandOutput: string,
  behavior: 'success' | 'timeout' | 'failure' = 'success',
) {
  const root = mkdtempSync(join(tmpdir(), 'board-hooks-'))
  hookRoots.push(root)
  const databasePath = join(root, 'orch.db')
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE board_message(record_id TEXT,number INTEGER,kind TEXT,ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,author_session TEXT);
    CREATE TABLE board_receipt(message_record_id TEXT,reader_session TEXT,delivered_at TEXT,acknowledged_at TEXT);
    CREATE TABLE hosted_board_message_cache(id TEXT,kind TEXT,payload TEXT);
    CREATE TABLE hosted_board_receipt_cache(message_id TEXT,reader_session TEXT,delivered_at TEXT,acknowledged_at TEXT);
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
  `)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_refresh_at', new Date().toISOString())
  const command = join(root, 'orch')
  const invocationLog = join(root, 'invocations')
  writeFileSync(
    command,
    behavior === 'timeout'
      ? `#!/bin/sh\nprintf x >> '${invocationLog}'\nsleep 2\n`
      : behavior === 'failure'
        ? `#!/bin/sh\nprintf x >> '${invocationLog}'\nexit 1\n`
        : `#!/bin/sh\nif [ "$2" = "presence" ]; then printf p >> '${root}/presence-calls'; printf '%s\\n' "$*" >> '${root}/presence-args'; exit 0; fi\nif [ "$2" = "pending" ]; then printf x >> '${invocationLog}'; printf '%s\\n' '${commandOutput}'; fi\n`,
  )
  chmodSync(command, 0o700)
  return { root, database, databasePath, command, invocationLog }
}

export function invocationCount(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(fixture.invocationLog, 'utf8').length
  } catch {
    return 0
  }
}

export function setCommandOutput(fixture: ReturnType<typeof createHookFixture>, output: string) {
  writeFileSync(
    fixture.command,
    `#!/bin/sh\nif [ "$2" = "presence" ]; then printf p >> '${fixture.root}/presence-calls'; printf '%s\\n' "$*" >> '${fixture.root}/presence-args'; exit 0; fi\nif [ "$2" = "pending" ]; then printf x >> '${fixture.invocationLog}'; printf '%s\\n' '${output}'; fi\n`,
  )
  chmodSync(fixture.command, 0o700)
}

export function presenceCallCount(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(join(fixture.root, 'presence-calls'), 'utf8').length
  } catch {
    return 0
  }
}

export function presenceArgs(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(join(fixture.root, 'presence-args'), 'utf8')
  } catch {
    return ''
  }
}

export function writeTranscript(fixture: ReturnType<typeof createHookFixture>) {
  const path = join(fixture.root, 'transcript.jsonl')
  writeFileSync(path, `${JSON.stringify({ timestamp: '2026-10-13T12:00:00.000Z' })}\n`)
  return path
}

export function addCandidate(fixture: ReturnType<typeof createHookFixture>, id: number) {
  fixture.database
    .query("INSERT INTO board_message VALUES (?,?, 'notice',1,NULL,?,NULL)")
    .run(newRecordId(), id, new Date(Date.now() + 60_000).toISOString())
}

export function runHook(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  extra = {},
) {
  return Bun.spawnSync(['python3', path], {
    stdin: Buffer.from(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ORCH_RUN_ID: '',
      ORCH_DB: fixture.databasePath,
      ORCH_BOARD_BIN: fixture.command,
      TMPDIR: fixture.root,
      BOARD_PUSH_REFRESH_SECONDS: String(BOARD_PUSH_REFRESH_SECONDS),
      BOARD_PUSH_REMIND_SECONDS: '300',
      BOARD_PUSH_RETRY_SECONDS: '15',
      BOARD_PRESENCE_REFRESH_SECONDS: String(BOARD_PRESENCE_REFRESH_SECONDS),
      BOARD_ACK_STOP_BLOCKS: '3',
      BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
      ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      ...extra,
    },
  })
}

type RepeatedHookResult = {
  outputs: string[]
  delivered: Array<[string, string[], string]>
  emittedLimit: number | null
  atomicWritten: boolean
  atomicValue: unknown
  atomicTemporaryFiles: string[]
}

export function runHookRepeatedResult(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  times: number,
  pendingValues: Array<
    Array<{ id: string; text: string; requiresAcknowledgement: boolean }>
  > | null = null,
  markFailure: boolean | 'once' = false,
) {
  const runner = [
    'import contextlib, importlib.util, io, json, os, sys',
    'sys.path.insert(0, os.path.dirname(sys.argv[1]))',
    'spec = importlib.util.spec_from_file_location("board_hook_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'pending_values = json.loads(sys.argv[4])',
    'if pending_values is not None:',
    '    pending_iterator = iter(pending_values)',
    '    module.pending = lambda session, recently_injected=None, exclude_acknowledgements=False: (lambda value: ([item for item in value if not (exclude_acknowledgements and item["requiresAcknowledgement"])], None, [item for item in value if item["requiresAcknowledgement"]]))(next(pending_iterator))',
    'delivered = []',
    'def mark_delivered(session, ids, delivery_point, emission_id, blocked_stop=False):',
    '    delivered.append([session, ids, emission_id])',
    '    failure_mode = json.loads(sys.argv[5])',
    '    if failure_mode is True or (failure_mode == "once" and len(delivered) == 1): raise RuntimeError("delivery stamp failed")',
    'module.mark_delivered = mark_delivered',
    'atomic_path = os.path.join(os.environ["ORCH_BOARD_HOOK_STATE"], "atomic-test")',
    'module.write_marker(atomic_path, {"previous": True})',
    'atomic_written = module.write_marker(atomic_path, {"partial": "value", "broken": object()})',
    'atomic_value = module.read_marker(atomic_path)',
    'atomic_temporary_files = [name for name in os.listdir(os.path.dirname(atomic_path)) if name.startswith(".marker-")]',
    'outputs = []',
    'for _ in range(int(sys.argv[3])):',
    '    output = io.StringIO()',
    '    sys.stdin = io.StringIO(sys.argv[2])',
    '    with contextlib.redirect_stdout(output): module.main()',
    '    outputs.append(output.getvalue())',
    'print(json.dumps({"outputs": outputs, "delivered": delivered, "emittedLimit": getattr(module, "STOP_EMITTED_ID_LIMIT", None), "atomicWritten": atomic_written, "atomicValue": atomic_value, "atomicTemporaryFiles": atomic_temporary_files}))',
  ].join('\n')
  const result = Bun.spawnSync(
    [
      'python3',
      '-c',
      runner,
      path,
      payload,
      String(times),
      JSON.stringify(pendingValues),
      JSON.stringify(markFailure),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ORCH_RUN_ID: '',
        ORCH_DB: fixture.databasePath,
        ORCH_BOARD_BIN: fixture.command,
        BOARD_PUSH_REFRESH_SECONDS: String(BOARD_PUSH_REFRESH_SECONDS),
        BOARD_PUSH_REMIND_SECONDS: '300',
        BOARD_PUSH_RETRY_SECONDS: '15',
        BOARD_PRESENCE_REFRESH_SECONDS: String(BOARD_PRESENCE_REFRESH_SECONDS),
        BOARD_ACK_STOP_BLOCKS: '3',
        BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
        ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      },
    },
  )
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as RepeatedHookResult
}

export function runHookRepeated(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  times: number,
  pendingValues: Array<
    Array<{ id: string; text: string; requiresAcknowledgement: boolean }>
  > | null = null,
) {
  return runHookRepeatedResult(path, payload, fixture, times, pendingValues).outputs
}

export const hookOutput = JSON.stringify({
  delivery: [
    {
      id: '7',
      text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7',
      requiresAcknowledgement: true,
    },
  ],
  overflow: null,
  pendingAcknowledgements: [
    {
      id: '7',
      text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7',
      requiresAcknowledgement: true,
    },
  ],
})
