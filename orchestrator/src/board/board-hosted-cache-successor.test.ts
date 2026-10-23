import { expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { newRecordId } from '../../../shared/record/schema.ts'
import { DB_PATH, db, SESSION_LIVE_MS } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { BOARD_CACHE_OWNER_KEY } from './board-hosted-cache.ts'

const userId = '01990000-0000-7000-8000-000000000001'

const message = (overrides: Partial<HostedBoardMessage> = {}): HostedBoardMessage => ({
  id: newRecordId(),
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted cache',
  body: 'cached body',
  audience: 'session:cache-reader',
  origin: {
    kind: 'architect',
    session: 'author',
    harness: 'claude',
    project: 'cache-project',
    projectStored: true,
    runId: null,
  },
  senderTags: [],
  createdAt: '2026-10-05T12:00:00.000Z',
  expiresAt: '2027-10-05T12:00:00.000Z',
  withdrawnAt: null,
  state: 'open',
  acceptedReplyId: null,
  acceptedBy: null,
  acceptedAt: null,
  noteId: null,
  notePendingError: null,
  revision: '1',
  scopeProjectIds: [],
  recipientUserIds: [],
  claimId: null,
  authorUserId: userId,
  authorSession: 'author',
  ackRequired: false,
  ackDeadline: null,
  ...overrides,
})

test('two database connections cannot both claim the hosted report reply successor', async () => {
  const clock = Date.parse('2026-10-16T12:00:00.000Z')
  const postedAt = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAt + 30_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?),(?,?)')
    .run(BOARD_CACHE_OWNER_KEY, userId, 'board_hosted_signed_in_user', userId)
  const putPresence = database.query(
    `INSERT INTO presence
     (session_id,harness,role,machine,project,cwd,first_seen,last_seen)
     VALUES (?,'claude','architect','machine','cache-project','/tmp',?,?)`,
  )
  putPresence.run('hosted-author', iso(postedAt - 1_000), iso(postedAt))
  putPresence.run('hosted-contender-one', iso(replyAt + 1_000), iso(clock))
  putPresence.run('hosted-contender-two', iso(replyAt + 2_000), iso(clock))
  const root = message({
    audience: 'session:hosted-author',
    authorSession: 'hosted-author',
    purpose: 'request',
    createdAt: iso(postedAt),
  })
  const reply = message({
    kind: 'reply',
    threadRootId: root.id,
    audience: null,
    createdAt: iso(replyAt),
  })
  const putMessage = database.query(
    'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
  )
  putMessage.run(root.id, root.kind, null, root.revision, JSON.stringify(root))
  putMessage.run(reply.id, reply.kind, root.id, reply.revision, JSON.stringify(reply))

  const childCode = `
    import { Database } from 'bun:sqlite'
    import { existsSync, writeFileSync } from 'node:fs'
    import { claimCachedHostedForPush } from './src/board/board-hosted-cache.ts'
    const database = new Database(process.env.BOTTEGA_ORCHESTRATOR_DB, { readwrite: true })
    database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    let snapshotRead = false
    const instrumented = new Proxy(database, {
      get(target, property) {
        if (property === 'query') return (sql) => {
          const statement = target.query(sql)
          if (snapshotRead || !sql.includes('successor_receipt.successor=1')) return statement
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== 'all') {
                const value = Reflect.get(statementTarget, statementProperty)
                return typeof value === 'function' ? value.bind(statementTarget) : value
              }
              return (...args) => {
                const result = statementTarget.all(...args)
                snapshotRead = true
                writeFileSync(process.env.CLAIM_READY, '')
                while (!existsSync(process.env.CLAIM_RELEASE))
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
                return result
              }
            },
          })
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const result = claimCachedHostedForPush(
      process.env.CLAIM_READER,
      false,
      Number(process.env.CLAIM_CLOCK),
      instrumented,
    )
    console.log(JSON.stringify(result.notices.map((notice) => notice.id)))
  `
  const readyPaths = [`${DB_PATH}.successor-one.ready`, `${DB_PATH}.successor-two.ready`]
  const releasePaths = [`${DB_PATH}.successor-one.release`, `${DB_PATH}.successor-two.release`]
  const readers = ['hosted-contender-one', 'hosted-contender-two']
  const children: ReturnType<typeof Bun.spawn>[] = []
  for (let index = 0; index < readers.length; index++) {
    rmSync(readyPaths[index]!, { force: true })
    rmSync(releasePaths[index]!, { force: true })
    children.push(
      Bun.spawn(['bun', '--eval', childCode], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAIM_CLOCK: String(clock),
          CLAIM_READY: readyPaths[index]!,
          CLAIM_READER: readers[index]!,
          CLAIM_RELEASE: releasePaths[index]!,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
  }
  const deadline = Date.now() + 5_000
  while (!readyPaths.every(existsSync) && Date.now() < deadline) await Bun.sleep(10)
  if (!readyPaths.every(existsSync)) {
    for (const path of releasePaths) writeFileSync(path, '')
    const errors = await Promise.all(
      children.map((child) => new Response(child.stderr as ReadableStream<Uint8Array>).text()),
    )
    for (const path of [...readyPaths, ...releasePaths]) rmSync(path, { force: true })
    throw new Error(`contenders did not read their snapshots: ${errors.join('\n')}`)
  }
  for (const path of releasePaths) writeFileSync(path, '')

  const results = await Promise.all(
    children.map(async (child) => ({
      exitCode: await child.exited,
      stdout: await new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      stderr: await new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    })),
  )
  for (const path of [...readyPaths, ...releasePaths]) rmSync(path, { force: true })
  expect(
    results.map((result) => result.exitCode),
    results.map((result) => result.stderr).join('\n'),
  ).toEqual([0, 0])
  expect(results.flatMap((result) => JSON.parse(result.stdout) as string[])).toEqual([reply.id])
  expect(
    database
      .query(
        'SELECT reader_session FROM hosted_board_receipt_cache WHERE message_id=? AND successor=1',
      )
      .all(reply.id),
  ).toHaveLength(1)
}, 15_000)
