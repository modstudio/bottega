import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { hostedBoardMessageView } from '../record/record-board-messages.ts'

const ownerUrl = process.env.ORCH_TEST_BOARD_AUTHOR_PROJECT_OWNER_URL
const actorUrl = process.env.ORCH_TEST_BOARD_AUTHOR_PROJECT_ACTOR_URL
const realPostgres = ownerUrl && actorUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')

const AUTHOR = '04990000-0000-7000-8000-000000000101'
const READER = '04990000-0000-7000-8000-000000000102'
const OUTSIDER = '04990000-0000-7000-8000-000000000103'
const SPACE_A = '04990000-0000-7000-8000-000000000111'
const SPACE_B = '04990000-0000-7000-8000-000000000112'
const SPACE_C = '04990000-0000-7000-8000-000000000113'
const PROJECT_A = '04990000-0000-7000-8000-000000000121'
const MESSAGE = '04990000-0000-7000-8000-000000000131'

realPostgres('hosted board posting project migration and visibility', () => {
  test('stores the project, returns its name only through project RLS, and leaves message visibility unchanged', async () => {
    const owner = new SQL(ownerUrl!)
    const actor = new SQL(actorUrl!)
    try {
      await migrate(drizzle({ client: owner }), { migrationsFolder })
      await owner`DELETE FROM board_message WHERE id=${MESSAGE}::uuid`
      await owner`DELETE FROM project WHERE id=${PROJECT_A}::uuid`
      await owner`DELETE FROM membership WHERE user_id IN (${AUTHOR}::uuid,${READER}::uuid,${OUTSIDER}::uuid)`
      await owner`DELETE FROM "user" WHERE id IN (${AUTHOR}::uuid,${READER}::uuid,${OUTSIDER}::uuid)`
      await owner`DELETE FROM space WHERE id IN (${SPACE_A}::uuid,${SPACE_B}::uuid,${SPACE_C}::uuid)`
      await owner`
        INSERT INTO space(id,name,slug,created_at) VALUES
          (${SPACE_A},'author-project-space','author-project-space',now()),
          (${SPACE_B},'shared-other-space','shared-other-space',now()),
          (${SPACE_C},'outside-space','outside-space',now())
      `
      await owner`
        INSERT INTO "user"(id,email,name,created_at) VALUES
          (${AUTHOR},'board-project-author@example.test','Author',now()),
          (${READER},'board-project-reader@example.test','Reader',now()),
          (${OUTSIDER},'board-project-outsider@example.test','Outsider',now())
      `
      await owner`
        INSERT INTO membership(id,space_id,user_id,role,permission,created_at) VALUES
          ('04990000-0000-7000-8000-000000000141',${SPACE_A},${AUTHOR},'member','write',now()),
          ('04990000-0000-7000-8000-000000000142',${SPACE_B},${AUTHOR},'member','write',now()),
          ('04990000-0000-7000-8000-000000000143',${SPACE_B},${READER},'member','write',now()),
          ('04990000-0000-7000-8000-000000000144',${SPACE_C},${OUTSIDER},'member','write',now())
      `
      await owner`INSERT INTO project(id,space_id,name,created_at) VALUES (${PROJECT_A},${SPACE_A},'private-origin',now())`
      await owner`
        INSERT INTO board_message
          (id,author_user_id,author_project_id,kind,audience,title,body,ack_required,expires_at,
           created_at,shared_space_reach,thread_root_author_user_id)
        VALUES (${MESSAGE},${AUTHOR},${PROJECT_A},'notice','spaces','Shared','Body',false,
          now() + interval '1 hour',now(),true,${AUTHOR})
      `
      const stored =
        await owner`SELECT author_project_id FROM board_message WHERE id=${MESSAGE}::uuid`
      expect(String(stored[0]!.author_project_id)).toBe(PROJECT_A)

      await actor.unsafe(
        `SET app.user_id='${READER}'; SET app.space_id='${SPACE_B}'; SET app.space_ids='${SPACE_B}'`,
      )
      const readerRows = (await actor`
        SELECT board_message.*, project.name AS author_project_name
        FROM board_message LEFT JOIN project ON project.id=board_message.author_project_id
        WHERE board_message.id=${MESSAGE}::uuid
      `) as Record<string, unknown>[]
      expect(readerRows).toHaveLength(1)
      expect(hostedBoardMessageView(readerRows[0]!, []).origin.project).toBeNull()

      await actor.unsafe(
        `SET app.user_id='${OUTSIDER}'; SET app.space_id='${SPACE_C}'; SET app.space_ids='${SPACE_C}'`,
      )
      expect(await actor`SELECT id FROM board_message WHERE id=${MESSAGE}::uuid`).toHaveLength(0)

      await actor.unsafe(
        `SET app.user_id='${AUTHOR}'; SET app.space_id='${SPACE_A}'; SET app.space_ids='${SPACE_A},${SPACE_B}'`,
      )
      const authorRows = (await actor`
        SELECT board_message.*, project.name AS author_project_name
        FROM board_message LEFT JOIN project ON project.id=board_message.author_project_id
        WHERE board_message.id=${MESSAGE}::uuid
      `) as Record<string, unknown>[]
      expect(hostedBoardMessageView(authorRows[0]!, []).origin.project).toBe('private-origin')
    } finally {
      await actor.close()
      await owner.close()
    }
  })
})
