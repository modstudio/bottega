import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = adminUrl ? describe : describe.skip

const SPACE_ID = '01990000-0000-7000-8000-000000001893'
const USER_ID = '01990000-0000-7000-8000-000000001894'
const MEMBERSHIP_ID = '01990000-0000-7000-8000-000000001895'
const PROJECT_ID = '01990000-0000-7000-8000-000000001896'
const MACHINE_ID = '01990000-0000-7000-8000-000000001897'
const RUN_ID = '01990000-0000-7000-8000-000000001898'

realPostgres('hosted jsonb string-refusal check', () => {
  test('refuses a top-level string and accepts a structured array', async () => {
    const sql = new SQL(adminUrl!)
    try {
      await sql
        .begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.space_id = '${SPACE_ID}'`)
          await tx.unsafe(`SET LOCAL app.user_id = '${USER_ID}'`)
          await tx`INSERT INTO space (id,name,slug,created_at)
          VALUES (${SPACE_ID}::uuid,'JSONB refusal proof','jsonb-refusal-proof',now())`
          await tx`INSERT INTO "user" (id,email,name,created_at)
          VALUES (${USER_ID}::uuid,'jsonb-refusal-proof@example.test','JSONB Refusal Proof',now())`
          await tx`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
          VALUES (${MEMBERSHIP_ID}::uuid,${SPACE_ID}::uuid,${USER_ID}::uuid,'member','write',now())`
          await tx`INSERT INTO project (id,space_id,name,key_prefixes,created_at)
          VALUES (${PROJECT_ID}::uuid,${SPACE_ID}::uuid,'jsonb-refusal-proof',ARRAY['DEV'],now())`
          await tx`INSERT INTO machine (id,user_id,name,registered_at,last_seen)
          VALUES (${MACHINE_ID}::uuid,${USER_ID}::uuid,'jsonb-refusal-proof',now(),now())`
          await tx`INSERT INTO run (
            id,space_id,project_id,machine_id,started_by_user_id,started_at,agent,job,
            prompt_sha,prompt_bytes,prompt_head,probe,status,turn,no_failover,automatic_failover,
            work_preserved,changed_paths,created_at,updated_at
          ) VALUES (
            ${RUN_ID}::uuid,${SPACE_ID}::uuid,${PROJECT_ID}::uuid,${MACHINE_ID}::uuid,
            ${USER_ID}::uuid,now(),'proof','proof','sha',1,'head',false,'ok',1,false,false,
            false,${['initial.ts']}::jsonb,now(),now()
          )`

          await tx`SAVEPOINT jsonb_string_write`
          let refusal: unknown
          try {
            await tx`UPDATE run SET changed_paths=${JSON.stringify(['double-encoded.ts'])}::jsonb
            WHERE id=${RUN_ID}::uuid`
          } catch (error) {
            refusal = error
          }
          await tx`ROLLBACK TO SAVEPOINT jsonb_string_write`
          expect(refusal).toMatchObject({
            code: '23514',
            constraint: 'run_changed_paths_not_json_string_check',
          })

          await tx`UPDATE run SET changed_paths=${['structured.ts']}::jsonb WHERE id=${RUN_ID}::uuid`
          const [stored] = await tx`
          SELECT changed_paths,jsonb_typeof(changed_paths) AS type FROM run WHERE id=${RUN_ID}::uuid
        `
          expect(stored).toEqual({ changed_paths: ['structured.ts'], type: 'array' })
          throw new Error('rollback jsonb refusal proof')
        })
        .catch((error) => {
          if (!(error instanceof Error) || error.message !== 'rollback jsonb refusal proof')
            throw error
        })
    } finally {
      await sql.close()
    }
  })
})
