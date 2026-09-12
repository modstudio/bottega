import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANSWER_WORKING_FORMS, CONTINUE_WORKING_FORMS, assertWorkerText, invalidUtf8Offset,
  misparsedMessage, parseAnswerTextSources, parseWorkerMessageArgs, readMessageText,
  readWorkerFile, refuseMisparsedMessage, flagValue, flagValues, isCliCommand, seedGuidance,
} from './args.ts'

const messageDir = mkdtempSync(join(tmpdir(), 'orch-args-test-'))
afterAll(() => rmSync(messageDir, { recursive: true, force: true }))

test('every registered top-level command is recognised as canon', () => {
  const commands = [
    'init-db', 'migrate', 'issue', 'contract', 'doc', 'canon', 'port', 'mcp', 'do', 'review', 'state', 'run',
    'search', 'result', 'wait', 'retry', 'project', 'ask-server', 'setup-ask', 'blockers', 'monitor', 'reclaim',
    'inbox', 'peek', 'answer', 'tell', 'continue', 'diff', 'sweep', 'discard', 'stop', 'abandon', 'score',
    'recalibrate', 'routing-backtest', 'runs', 'guide', 'spawns', 'stats', 'pick', 'pending', 'metric', 'serve',
    'reclassify-failures', 'health', 'doctor', 'jobs', 'agents', 'workflow', 'lens', 'note', 'judge',
    'close-out', 'confinement', 'flake', 'reconcile', 'epic',
  ]
  for (const command of commands) expect(isCliCommand(command)).toBeTrue()
  expect(isCliCommand('nosuch')).toBeFalse()
})

test('the singleton reader refuses duplicates while the plural reader preserves them', () => {
  for (const values of [['all', 'all'], ['adequate', 'empty'], ['all', 'banana']]) {
    const argv = ['score', '1', 'full', 'right', '--grade', values[0]!, `--grade=${values[1]}`]
    expect(() => flagValue(argv, 'grade')).toThrow(
      `--grade may be supplied only once; received ${JSON.stringify(values[0])} and ${JSON.stringify(values[1])}`,
    )
    expect(flagValues(argv, 'grade')).toEqual(values)
  }
})

test('the no-seed guidance spells exactly the accepted forms', () => {
  const seeds = ['none', '--bundle=minimal', '--tables=account,order', '--full']
  expect(seedGuidance(seeds)).toBe(
    `  --seed none\n  --seed=none\n` +
    `  --seed --bundle=minimal\n  --seed=--bundle=minimal\n` +
    `  --seed --tables=account,order\n  --seed=--tables=account,order\n` +
    `  --seed --full\n  --seed=--full\n` +
    `Multi-token seed specs must be quoted as one value, for example:\n` +
    `  --seed "--bundle=catalog --budget-mb=700"\n` +
    `  --seed="--bundle=catalog --budget-mb=700"`,
  )
  for (const seed of seeds) {
    expect(flagValue(['do', 'implement', '--seed', seed], 'seed')).toBe(seed)
    expect(flagValue(['do', 'implement', `--seed=${seed}`], 'seed')).toBe(seed)
  }
})


describe('answer text sources', () => {
  test('--q<id> --file PATH binds that file to that question', () => {
    expect(parseAnswerTextSources(['--q264', '--file', 'a.txt', '--q265', '--file', 'b.txt']))
      .toEqual({
        byId: [{ id: 264, file: 'a.txt' }, { id: 265, file: 'b.txt' }],
        commandFile: undefined,
        positionals: [],
      })
  })

  test('mixed positional --q values and per-question --file', () => {
    expect(parseAnswerTextSources(['--q264', 'use option A', '--q265', '--file', 'b.txt']))
      .toEqual({
        byId: [{ id: 264, text: 'use option A' }, { id: 265, file: 'b.txt' }],
        commandFile: undefined,
        positionals: [],
      })
  })

  test('a command-level --file is distinct from a per-question --file', () => {
    expect(parseAnswerTextSources(['--file', 'ruling.txt'])).toEqual({
      byId: [], commandFile: 'ruling.txt', positionals: [],
    })
  })

  test('a quoted dash-prefixed value is message text, not an unknown flag', () => {
    expect(parseAnswerTextSources(['--literal is intended'])).toEqual({
      byId: [], commandFile: undefined, positionals: ['--literal is intended'],
    })
    expect(parseAnswerTextSources(['--q31', '--literal is intended'])).toEqual({
      byId: [{ id: 31, text: '--literal is intended' }],
      commandFile: undefined,
      positionals: [],
    })
  })

  test('once the message starts, flag-shaped words stay in the message', () => {
    expect(parseAnswerTextSources(['use', '--quiet', 'mode'])).toEqual({
      byId: [], commandFile: undefined, positionals: ['use', '--quiet', 'mode'],
    })
    expect(parseWorkerMessageArgs(['use', '--agent', 'codex', 'exactly'])).toEqual({
      byId: [], commandFile: undefined, positionals: ['use', '--agent', 'codex', 'exactly'],
    })
    expect(parseAnswerTextSources(['--follow', 'use', '--quiet', 'mode'])).toEqual({
      byId: [], commandFile: undefined, positionals: ['use', '--quiet', 'mode'],
    })
  })
})

describe('a message that is not a ruling is refused', () => {
  test('empty, whitespace, and a single --token are mis-parses', () => {
    expect(misparsedMessage('')).toBe('empty')
    expect(misparsedMessage('   \n')).toBe('empty')
    expect(misparsedMessage('--file')).toBe('dash-token')
    expect(misparsedMessage(' --file ')).toBe('dash-token')
    expect(misparsedMessage('use --file')).toBeNull()
    expect(misparsedMessage('Use $var and `cmd`.')).toBeNull()
    expect(misparsedMessage('--literal is intended')).toBeNull()
  })

  test('invalid UTF-8 is reported at the first bad byte', () => {
    expect(invalidUtf8Offset(Buffer.from([0x66, 0x80, 0xff, 0x67]))).toBe(1)
    expect(invalidUtf8Offset(Buffer.from('ok'))).toBeNull()
  })

  test('the refusal names what was received and the working forms', () => {
    expect(() => refuseMisparsedMessage('--file', 'ruling', ANSWER_WORKING_FORMS)).toThrow(
      'received "--file" as a ruling',
    )
    expect(() => refuseMisparsedMessage('--file', 'ruling', ANSWER_WORKING_FORMS))
      .toThrow(ANSWER_WORKING_FORMS)
    expect(() => refuseMisparsedMessage('  ', 'ruling', ANSWER_WORKING_FORMS))
      .toThrow('empty ruling: received "  "')
  })
})

describe('continue message grammar', () => {
  test('continue --file reads the follow-up without shell interpolation', async () => {
    const path = join(messageDir, 'literal.txt')
    const body = 'Next: keep `literal` and $(hostname) byte-for-byte.\n'
    writeFileSync(path, body)
    const sources = parseWorkerMessageArgs(['--file', path])
    expect(await readMessageText({ missing: 'missing', sources })).toBe(body)
  })

  test('continue refuses a follow-up that is only --file', async () => {
    const path = join(messageDir, 'dash.txt')
    writeFileSync(path, '--file')
    const text = readWorkerFile(path)
    expect(() => assertWorkerText(text, 'message', CONTINUE_WORKING_FORMS))
      .toThrow('received "--file" as a message')
  })

  test('continue accepts a two-word follow-up beginning with --', async () => {
    const sources = parseWorkerMessageArgs(['--literal is intended'])
    const text = await readMessageText({ missing: 'missing', sources })
    expect(text).toBe('--literal is intended')
    expect(() => assertWorkerText(text!, 'message', CONTINUE_WORKING_FORMS)).not.toThrow()
  })

  test('continue --file refuses a NUL and names the byte offset', () => {
    const path = join(messageDir, 'nul.bin')
    writeFileSync(path, Buffer.from('A\0B'))
    expect(() => assertWorkerText(readWorkerFile(path), 'message', CONTINUE_WORKING_FORMS))
      .toThrow('NUL at byte offset 1')
  })

  test('continue --file refuses a prompt above the argv resume bound', () => {
    const path = join(messageDir, 'large.txt')
    const bytes = 1024 * 1024
    writeFileSync(path, 'A'.repeat(bytes))
    expect(() => assertWorkerText(readWorkerFile(path), 'message', CONTINUE_WORKING_FORMS, bytes - 1))
      .toThrow(`message is ${bytes} bytes`)
  })

  test('continue --file refuses invalid UTF-8 at the byte offset', () => {
    const path = join(messageDir, 'utf8.bin')
    writeFileSync(path, Buffer.from([0x66, 0x80, 0xff, 0x67]))
    expect(() => readWorkerFile(path)).toThrow('invalid UTF-8')
    expect(() => readWorkerFile(path)).toThrow('byte offset 1')
  })

  test('continue stdin refuses invalid UTF-8 at the byte offset', async () => {
    const stdin = { isTTY: false, async bytes() { return Buffer.from([0x66, 0x80, 0xff, 0x67]) } }
    await expect(readMessageText({ missing: 'missing', sources: { positionals: [] } }, stdin))
      .rejects.toThrow('invalid UTF-8 in stdin at byte offset 1')
  })

  test('continue stdin refuses whitespace-only input instead of substituting the canned prompt', async () => {
    const stdin = { isTTY: false, async bytes() { return Buffer.from([0x20, 0x09, 0x0d, 0x0a]) } }
    const text = await readMessageText({ missing: 'missing', sources: { positionals: [] } }, stdin)
    expect(() => assertWorkerText(text!, 'message', CONTINUE_WORKING_FORMS)).toThrow('empty message')
  })

  test('continue stdin refuses an empty pipe instead of substituting the canned prompt', async () => {
    const stdin = { isTTY: false, async bytes() { return Buffer.alloc(0) } }
    const text = await readMessageText({ missing: 'missing', sources: { positionals: [] } }, stdin)
    expect(() => assertWorkerText(text!, 'message', CONTINUE_WORKING_FORMS)).toThrow('empty message')
  })

  test('continue keeps flag-shaped words after the message starts', async () => {
    const sources = parseWorkerMessageArgs(['use', '--quiet', 'mode'], { booleans: ['--quiet'] })
    expect(await readMessageText({ missing: 'missing', sources })).toBe('use --quiet mode')
  })
})
