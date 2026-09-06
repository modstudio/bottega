import { describe, expect, test } from 'bun:test'
import {
  ANSWER_WORKING_FORMS, invalidUtf8Offset, misparsedMessage, parseAnswerTextSources,
  parseWorkerMessageArgs, refuseMisparsedMessage, flagValue, flagValues, isCliCommand, seedGuidance,
  validateCliArgs,
} from './args.ts'

describe('CLI argument recognition', () => {
  test('every parser top-level command is recognised as canon, including nested commands', () => {
    const commands = [
      'issue', 'land', 'contract', 'doc', 'canon', 'port', 'mcp', 'do', 'review', 'state', 'run',
      'search', 'result', 'wait', 'retry', 'project', 'ask-server', 'setup-ask', 'blockers', 'monitor',
      'inbox', 'answer', 'tell', 'continue', 'diff', 'sweep', 'discard', 'stop', 'abandon', 'score',
      'recalibrate', 'routing-backtest', 'runs', 'guide', 'spawns', 'stats', 'pick', 'pending', 'metric', 'serve',
      'reclassify-failures', 'doctor', 'jobs', 'agents',
    ]
    for (const command of commands) expect(isCliCommand(command)).toBeTrue()
    expect(isCliCommand('nosuch')).toBeFalse()
  })

  test('every command with legitimate positionals still accepts its documented shape', () => {
    const commands = [
      ['land', 'feature/DEV-185'], ['land', '--status'],
      ['land', '12', '--message', 'fuller reasoning'], ['land', '12', '--file', 'msg.txt'],
      ['issue', 'DEV-175'], ['contract', 'implement'],
      ['workflow','list','--json'], ['workflow','show','ship','--version','1'],
      ['workflow','set','ship','--file','ship.json','--reason','change'],
      ['workflow','promote','ship','2','--reason','ready'], ['workflow','retire','ship','2','--reason','withdrawn'],
      ['workflow','fork','ship','--from','1','--reason','revise'], ['workflow','versions','ship','--json'],
      ['workflow','compose','ship','--mode','default','--arg','key=DEV-257','--arg','branch=x'],
      ['workflow','step','ship','lens','--arg','key=DEV-257'], ['workflow','export','out'],
      ['workflow','import','out','--reason','restore'],
      ['canon', 'eval', '--slug', 'asks-instead-of-deciding', '--agent', 'codex', '--json', '--force'],
      ['canon', 'evals', '--json'],
      ['doc', 'show', 'slug', '--scope', 'global'],
      ['doc', 'set', 'slug', '--scope', 'global', '--title', 'Title', '--file', 'body.md'],
      ['doc', 'consume', 'slug', '--scope', 'global'],
      ['doc', 'rm', 'slug', '--scope', 'global'], ['doc', 'export', 'docs'],
      ['doc', 'import', 'docs'], ['do', 'summarize', '--cwd', '/tmp/project', 'a', 'multi-word', 'prompt'],
      ['review', 'record', '12', '13'],
      ['review', 'list', '--open', '--project', 'known', '--since', '2026-01-01T00:00:00Z', '--json'],
      ['review', 'show', '12', '--json'], ['review', '--help'],
      ['review', 'tier', 'feature/DEV-305', '--json'],
      ['review', 'triage', '12', '1', 'rejected', '--category', 'not-a-defect', '--severity', 'critical'],
      ['review', 'complete', '12'],
      ['review', 'pins'], ['review', 'pins', '--prune'],
      ['review', 'calibration', 'correctness', 'codex', 'gpt-5', '--json'],
      ['review', 'calibration', '--json'],
      ['run', '12'], ['result', '12', '--quiet'],
      ['wait', '12', '13', '--timeout', '30'], ['retry', '12', '--agent', 'codex'],
      ['project', 'add', '/tmp/project', '--name', 'project'],
      ['project', 'set', 'project', '--settings', '{"gate":"bun run check"}'],
      ['project', 'remove', 'project'],
      ['port', 'baseline', 'show', 'source', 'target', '--json'],
      ['port', 'baseline', 'set', 'source', 'target', 'abc'],
      ['port', 'skip', 'list', 'source', 'target'],
      ['port', 'skip', 'add', 'source', 'target', 'candidate', '--reason', 'not applicable'],
      ['port', 'ref', 'list', '--all'], ['port', 'ref', 'show', 'TGT-1'],
      ['port', 'ref', 'set', 'TGT-1', '--sources', '[]', '--note', 'native'],
      ['port', 'ref', 'resolve', 'TGT-1'], ['port', 'ref', 'delete-error', 'TGT-1'],
      ['port', 'doctrine', 'list', '--all'],
      ['port', 'doctrine', 'add', '1', '--title', 'Rule', '--file', 'rule.md'],
      ['port', 'doctrine', 'retire', '1'],
      ['answer', '12', 'first ruling', 'second ruling'],
      ['answer', '12', '--q31', 'first ruling', '--q32', 'second ruling'],
      ['answer', '12', '--q31', '--file', 'a.txt'],
      ['answer', '12', '--q31', '--file', 'a.txt', '--q32', '--file', 'b.txt'],
      ['answer', '12', '--q31', 'first ruling', '--q32', '--file', 'b.txt'],
      ['tell', '12', 'context', 'for', 'the worker'], ['tell', '12', '--file', 'note.md'],
      ['continue', '12', 'one more change'], ['continue', '12', '--file', 'msg.txt'],
      ['continue', '12', 'hello', 'world'], ['diff', '12', '--quiet'], ['discard', '12', '--force'],
      ['stop', '12'], ['abandon', '12', '--note', 'superseded'],
      ['score', '12', 'full', 'right', 'faithful', '--note', 'good',
        '--reproduced', 'all', '--coverage', 'adequate', '--limits', 'named', '--overlap', 'alone'],
      ['routing-backtest', '--job', 'implement', '--seed', '7', '--json'],
      ['runs', '--id', '12', '--id', '13', '--json'],
      ['pick', 'implement', '--distinct-from', '10,11'], ['metric', 'collect', '--days', '30'],
    ]
    for (const argv of commands) expect(() => validateCliArgs(argv)).not.toThrow()
  })

  test('a stray positional is named with the working form', () => {
    expect(() => validateCliArgs(['project', 'set', 'registered', 'gate', 'bun run check']))
      .toThrow('unrecognised argument: gate\nworking form: orch project set <name>')
  })

  test('an unknown flag is named with the working form', () => {
    expect(() => validateCliArgs(['runs', '--jobs', 'implement']))
      .toThrow('unrecognised argument: --jobs\nworking form: orch runs')
  })

  test('a value flag without its value is refused before execution', () => {
    expect(() => validateCliArgs(['project', 'set', 'registered', '--settings']))
      .toThrow('argument --settings needs a value\nworking form: orch project set <name>')
    expect(() => validateCliArgs(['project', 'set', 'registered', '--settings=']))
      .toThrow('argument --settings needs a value\nworking form: orch project set <name>')
  })

  test('a known value flag consumes a dash-prefixed value', () => {
    for (const seed of ['none', '--bundle=minimal', '--tables=account,order', '--full']) {
      expect(() => validateCliArgs(['do', 'implement', '--seed', seed, 'make the change'])).not.toThrow()
      expect(() => validateCliArgs(['do', 'implement', `--seed=${seed}`, 'make the change'])).not.toThrow()
    }
    expect(() => validateCliArgs([
      'do', 'implement', '--seed', '--bundle=catalog --budget-mb=700', 'make the change',
    ])).not.toThrow()
    expect(() => validateCliArgs([
      'do', 'implement', '--seed=--bundle=catalog --budget-mb=700', 'make the change',
    ])).not.toThrow()
    expect(() => validateCliArgs([
      'do', 'implement', '--seed', ' --bundle=minimal', 'make the change',
    ])).not.toThrow()
  })

  test('the singleton reader refuses every duplicate while the plural reader preserves them', () => {
    for (const values of [['all', 'all'], ['adequate', 'empty'], ['all', 'banana']]) {
      const argv = ['score', '1', 'full', 'right', '--grade', values[0]!, `--grade=${values[1]}`]
      expect(() => flagValue(argv, 'grade')).toThrow(
        `--grade may be supplied only once; received ${JSON.stringify(values[0])} and ${JSON.stringify(values[1])}`,
      )
      expect(flagValues(argv, 'grade')).toEqual(values)
    }
  })

  test('the no-seed guidance spells exactly the accepted starship forms', () => {
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
      for (const args of [['--seed', seed], [`--seed=${seed}`]]) {
        const argv = ['do', 'implement', ...args, 'make the change']
        expect(() => validateCliArgs(argv)).not.toThrow()
        expect(flagValue(argv, 'seed')).toBe(seed)
      }
    }
    const multiToken = '--bundle=catalog --budget-mb=700'
    for (const args of [['--seed', multiToken], [`--seed=${multiToken}`]]) {
      const argv = ['do', 'implement', ...args, 'make the change']
      expect(() => validateCliArgs(argv)).not.toThrow()
      expect(flagValue(argv, 'seed')).toBe(multiToken)
    }
  })

  test('a --q flag followed by another flag that is not --file needs a value', () => {
    expect(() => validateCliArgs(['answer', '12', '--q31', '--follow']))
      .toThrow('argument --q31 needs a value')
  })

  test('a dash-prefixed message after the run id is accepted for answer, tell, and continue', () => {
    const message = '--literal is intended'
    expect(() => validateCliArgs(['answer', '12', message])).not.toThrow()
    expect(() => validateCliArgs(['tell', '12', message])).not.toThrow()
    expect(() => validateCliArgs(['continue', '12', message])).not.toThrow()
    expect(() => validateCliArgs(['answer', '12', '--q31', message])).not.toThrow()
  })
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
    expect(() => validateCliArgs(['answer', '12', 'use', '--quiet', 'mode'])).not.toThrow()
    expect(() => validateCliArgs(['tell', '12', 'use', '--agent', 'codex', 'exactly'])).not.toThrow()
    expect(() => validateCliArgs(['continue', '12', 'use', '--quiet', 'mode'])).not.toThrow()
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
