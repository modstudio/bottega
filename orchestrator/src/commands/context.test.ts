import { expect, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { parse } from 'shell-quote'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { run } from '../cli/program.ts'
import { db } from '../database/db.ts'
import { getContextItem } from '../doc/context-item-store.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { registerLocalProject } from '../project/project-registration.ts'
import { compactionCaptureSource } from '../session-losses/session-losses.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

const compactFirstAct = async () => {
  const source = await Bun.file(resolve(import.meta.dir, '../../hooks/session-brief.py')).text()
  const assignment = source.match(/COMPACT_FIRST_ACT\s*=\s*\(([\s\S]*?)\n\)/)?.[1]
  if (!assignment) throw new Error('session-brief.py does not define COMPACT_FIRST_ACT')
  return [...assignment.matchAll(/"(?:\\.|[^"\\])*"/g)]
    .map(([literal]) => JSON.parse(literal) as string)
    .join('')
}

test('post-compaction first act prints an accepted context set command', async () => {
  registerLocalProject(
    {
      recordId: newRecordId(),
      name: 'compaction-fixture',
      path: '/fixture/compaction',
      stack: null,
      canon: false,
      retiredAt: null,
      settings: { keyPrefixes: ['CTX'] },
    },
    null,
    db(),
  )
  const task = {
    key: 'CTX-2574',
    record_id: newRecordId(),
    project: 'compaction-fixture',
    title: 'Compaction context command fixture',
    parent_key: null,
    status: 'open',
    status_category: 'active',
    last_seen: null,
    has_children: false,
  }
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => task,
    lookup: async () => task,
    record: async () => task,
    children: async () => [],
    pointer: async () => null,
  }
  try {
    const firstAct = (await compactFirstAct()).replace('{session}', 'session-a')
    const command = [...firstAct.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]!)
      .find((candidate) => candidate.startsWith(`${PLATFORM_SLUG} agent context set `))
    expect(command).toBeDefined()
    const expanded = command!
      .replace('<KEY>', task.key)
      .replace('<slug>', 'compaction-fact')
      .replace('<line>', 'A fact retained across compaction')
    const argv = parse(expanded).filter((part): part is string => typeof part === 'string')

    expect(argv.slice(0, 2)).toEqual([PLATFORM_SLUG, 'agent'])
    expect(argv[argv.indexOf('--source') + 1]).toBe(compactionCaptureSource('session-a'))
    expect(await run(argv.slice(2))).toBe(0)
    expect((await getContextItem(`task:${task.record_id}`, 'compaction-fact'))?.body).toBe(
      'A fact retained across compaction',
    )
  } finally {
    delete globals[CONTEXT_FACTS_PORTS_KEY]
  }
})

test('agent context set refuses matching record shapes without writing', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  const session = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    const cases = [
      {
        kind: 'ruling',
        body: 'x'.repeat(1501),
        refusal: 'ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)',
      },
    ]
    for (const { kind, body, refusal } of cases) {
      const source = kind === 'ruling' ? 'q1' : 'test'
      expect(
        await run([
          'context',
          'set',
          '--session',
          session,
          '--kind',
          kind,
          '--source',
          source,
          '--id',
          'shape',
          body,
        ]),
      ).toBe(1)
      expect(errors.at(-1)).toContain(refusal)
      expect(await getContextItem(`session:${session}`, 'shape')).toBeNull()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
    error.mockRestore()
  }
})

test('agent context set and drop expose cursor holders', async () => {
  const session = newRecordId()
  const cursor = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  db().exec('PRAGMA foreign_keys=OFF')
  db()
    .query(`INSERT INTO workflow_cursor
    (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
     workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at)
    VALUES (?,999,'fixture','explore','default','','instance',?,?,?,'{}',3,?,?)`)
    .run(
      cursor,
      session,
      newRecordId(),
      newRecordId(),
      new Date().toISOString(),
      new Date().toISOString(),
    )
  try {
    expect(
      await run([
        'context',
        'set',
        '--cursor',
        cursor,
        '--kind',
        'fact',
        '--source',
        'test',
        '--id',
        'cursor-item',
        'cursor fact',
      ]),
    ).toBe(0)
    expect((await getContextItem(`cursor:${cursor}`, 'cursor-item'))?.body).toBe('cursor fact')
    expect(await run(['context', 'drop', '--cursor', cursor, '--id', 'cursor-item'])).toBe(0)
    expect(await getContextItem(`cursor:${cursor}`, 'cursor-item')).toBeNull()
  } finally {
    db().exec('PRAGMA foreign_keys=ON')
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
})
