import { beforeAll, expect, test } from 'bun:test'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import type { PsqlResult } from './fixtures/postgres-rls.ts'

type BoardProofInput = {
  admin: (statement: string) => string
  psql: (user: string, password: string, statement: string) => PsqlResult
  readerRole: string
}

const IDS = {
  userA: '02990000-0000-7000-8000-000000000101',
  userB: '02990000-0000-7000-8000-000000000102',
  userC: '02990000-0000-7000-8000-000000000103',
  userD: '02990000-0000-7000-8000-000000000104',
  spaceA: '02990000-0000-7000-8000-000000000111',
  spaceB: '02990000-0000-7000-8000-000000000112',
  projectA: '02990000-0000-7000-8000-000000000121',
  projectB: '02990000-0000-7000-8000-000000000122',
  projectA2: '02990000-0000-7000-8000-000000000123',
  membershipA1: '02990000-0000-7000-8000-000000000131',
  membershipA2: '02990000-0000-7000-8000-000000000132',
  membershipB: '02990000-0000-7000-8000-000000000133',
  membershipC: '02990000-0000-7000-8000-000000000134',
  authorOnly: '02990000-0000-7000-8000-000000000001',
  scopedA: '02990000-0000-7000-8000-000000000002',
  scopedBoth: '02990000-0000-7000-8000-000000000003',
  recipientOnly: '02990000-0000-7000-8000-000000000004',
  scopedRecipient: '02990000-0000-7000-8000-000000000005',
  tag: 'tag',
  claimA: '02990000-0000-7000-8000-000000000011',
  claimB: '02990000-0000-7000-8000-000000000012',
  revisionA: '02990000-0000-7000-8000-000000000021',
  revisionB: '02990000-0000-7000-8000-000000000022',
  invisibleReply: '02990000-0000-7000-8000-000000000043',
  mismatchedReply: '02990000-0000-7000-8000-000000000044',
} as const

function actor(
  input: BoardProofInput,
  userId: string,
  spaceIds: string[],
  statement: string,
): PsqlResult {
  return input.psql(
    RECORD_ACTOR_ROLE,
    'actor-password',
    `SET app.user_id='${userId}';
     SET app.space_id='${spaceIds[0] ?? ''}';
     SET app.space_ids='${spaceIds.join(',')}';
     ${statement}`,
  )
}

function visibleCount(input: BoardProofInput, userId: string, messageId: string): string {
  return actor(
    input,
    userId,
    [IDS.spaceA, IDS.spaceB],
    `SELECT count(*) FROM board_message WHERE id='${messageId}';`,
  ).stdout
}

function messageValues(
  id: string,
  author: string,
  scope: string[],
  recipients: string[] = [],
): string {
  return `('${id}','${author}','notice','architects','proof','proof',false,
    now() + interval '1 hour',now(),ARRAY[${scope.map((id) => `'${id}'::uuid`).join(',')}]::uuid[],
    ARRAY[${recipients.map((id) => `'${id}'::uuid`).join(',')}]::uuid[])`
}

export function registerBoardRlsProofs(input: BoardProofInput): void {
  beforeAll(() => {
    input.admin(`
      INSERT INTO space (id,name,slug,created_at) VALUES
        ('${IDS.spaceA}','board-space-a','board-space-a',now()),
        ('${IDS.spaceB}','board-space-b','board-space-b',now());
      INSERT INTO "user" (id,email,name,created_at) VALUES
        ('${IDS.userA}','board-a@example.test','Board A',now()),
        ('${IDS.userB}','board-b@example.test','Board B',now()),
        ('${IDS.userC}','board-c@example.test','Board C',now()),
        ('${IDS.userD}','board-d@example.test','Board D',now());
      INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
        ('${IDS.membershipA1}','${IDS.spaceA}','${IDS.userA}','member','write',now()),
        ('${IDS.membershipA2}','${IDS.spaceB}','${IDS.userA}','member','write',now()),
        ('${IDS.membershipB}','${IDS.spaceA}','${IDS.userB}','member','write',now()),
        ('${IDS.membershipC}','${IDS.spaceA}','${IDS.userC}','member','read',now());
      INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
        ('${IDS.projectA}','${IDS.spaceA}','board-alpha',ARRAY['BOARD'],now()),
        ('${IDS.projectA2}','${IDS.spaceA}','board-alpha-two',ARRAY['BOARD2'],now()),
        ('${IDS.projectB}','${IDS.spaceB}','board-beta',ARRAY['BOARD'],now());
      INSERT INTO board_message
        (id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at,
         scope_project_ids,recipient_user_ids)
      VALUES
        ${messageValues(IDS.authorOnly, IDS.userA, [])},
        ${messageValues(IDS.scopedA, IDS.userA, [IDS.projectA])},
        ${messageValues(IDS.scopedBoth, IDS.userA, [IDS.projectA, IDS.projectB])},
        ${messageValues(IDS.recipientOnly, IDS.userA, [], [IDS.userD])},
        ${messageValues(IDS.scopedRecipient, IDS.userA, [IDS.projectA], [IDS.userD])};
      INSERT INTO board_message_tag (message_id,kind,value,origin)
      VALUES ('${IDS.scopedA}','topic','${IDS.tag}','sender');
      INSERT INTO board_receipt
        (message_id,reader_user_id,reader_session,audience_at_posting,delivered_at)
      VALUES
        ('${IDS.scopedA}','${IDS.userA}','operator',true,now()),
        ('${IDS.scopedA}','${IDS.userB}','worker-chain',true,now());
      INSERT INTO board_claim
        (id,project_id,subject_kind,subject_value,holder_user_id,duration_ms,taken_at,
         renewed_at,lapses_at)
      VALUES ('${IDS.claimA}','${IDS.projectA}','path','src/a.ts','${IDS.userA}',60000,
        now(),now(),now() + interval '1 minute');
    `)
  })

  test('a board author sees their own message whatever its scope', () => {
    expect(visibleCount(input, IDS.userA, IDS.scopedBoth)).toBe('1')
    expect(visibleCount(input, IDS.userA, IDS.authorOnly)).toBe('1')
  })

  test("a one-project board message is visible to that project's space members only", () => {
    expect(visibleCount(input, IDS.userB, IDS.scopedA)).toBe('1')
    expect(visibleCount(input, IDS.userC, IDS.scopedA)).toBe('1')
    expect(visibleCount(input, IDS.userD, IDS.scopedA)).toBe('0')
  })

  test('a board message scoped across spaces requires membership in both', () => {
    expect(visibleCount(input, IDS.userA, IDS.scopedBoth)).toBe('1')
    expect(visibleCount(input, IDS.userB, IDS.scopedBoth)).toBe('0')
    expect(visibleCount(input, IDS.userC, IDS.scopedBoth)).toBe('0')
    expect(visibleCount(input, IDS.userD, IDS.scopedBoth)).toBe('0')
  })

  test('an empty-scope board message is visible only to its author and explicit recipients', () => {
    expect(visibleCount(input, IDS.userA, IDS.recipientOnly)).toBe('1')
    expect(visibleCount(input, IDS.userD, IDS.recipientOnly)).toBe('1')
    expect(visibleCount(input, IDS.userB, IDS.recipientOnly)).toBe('0')
    expect(visibleCount(input, IDS.userC, IDS.recipientOnly)).toBe('0')
  })

  test('an explicit recipient without scoped-project membership cannot see the message', () => {
    expect(visibleCount(input, IDS.userD, IDS.scopedRecipient)).toBe('0')
  })

  test('removing membership removes visibility of an existing board message', () => {
    expect(visibleCount(input, IDS.userB, IDS.scopedA)).toBe('1')
    input.admin(`DELETE FROM membership WHERE id='${IDS.membershipB}';`)
    try {
      expect(visibleCount(input, IDS.userB, IDS.scopedA)).toBe('0')
    } finally {
      input.admin(`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES ('${IDS.membershipB}','${IDS.spaceA}','${IDS.userB}',
          'member','write',now());`)
    }
  })

  test('a read-permission member reads but cannot insert a scoped board message', () => {
    expect(visibleCount(input, IDS.userC, IDS.scopedA)).toBe('1')
    const inserted = actor(
      input,
      IDS.userC,
      [IDS.spaceA],
      `INSERT INTO board_message
       (id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at,
        scope_project_ids,recipient_user_ids)
       VALUES ${messageValues('02990000-0000-7000-8000-000000000041', IDS.userC, [IDS.projectA])};`,
    )
    expect(inserted.code).not.toBe(0)
    expect(inserted.stderr).toContain('row-level security policy')
  })

  test('a user cannot insert a board message naming another author', () => {
    const inserted = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_message
       (id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at,
        scope_project_ids,recipient_user_ids)
       VALUES ${messageValues('02990000-0000-7000-8000-000000000042', IDS.userA, [IDS.projectA])};`,
    )
    expect(inserted.code).not.toBe(0)
    expect(inserted.stderr).toContain('row-level security policy')
  })

  test('a non-author cannot change a board message or insert or delete its tags', () => {
    const update = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `UPDATE board_message SET body='changed' WHERE id='${IDS.scopedA}';`,
    )
    expect(update.code, update.stderr).toBe(0)
    expect(update.stdout).toBe('')
    const deletion = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `DELETE FROM board_message WHERE id='${IDS.scopedA}';`,
    )
    expect(deletion.code, deletion.stderr).toBe(0)
    expect(deletion.stdout).toBe('')
    expect(input.admin(`SELECT body FROM board_message WHERE id='${IDS.scopedA}';`)).toBe('proof')
    const insertTag = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_message_tag (message_id,kind,value,origin)
       VALUES ('${IDS.scopedA}','topic','foreign','sender');`,
    )
    expect(insertTag.code).not.toBe(0)
    const deleteTag = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `DELETE FROM board_message_tag
       WHERE message_id='${IDS.scopedA}' AND value='${IDS.tag}';`,
    )
    expect(deleteTag.code, deleteTag.stderr).toBe(0)
    expect(deleteTag.stdout).toBe('')
    expect(
      input.admin(`SELECT count(*) FROM board_message_tag WHERE message_id='${IDS.scopedA}';`),
    ).toBe('1')
  })

  test('a reply to a board root the user cannot see is refused', () => {
    const reply = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_message
       (id,author_user_id,kind,thread_root_id,body,ack_required,created_at,
        scope_project_ids,recipient_user_ids)
       VALUES ('${IDS.invisibleReply}','${IDS.userB}','reply',
        '${IDS.authorOnly}','reply',false,now(),ARRAY[]::uuid[],ARRAY[]::uuid[]);`,
    )
    expect(reply.code).not.toBe(0)
    expect(reply.stderr).toContain('board reply thread root is not visible')
  })

  test("a reply's scope and recipients must match its board root", () => {
    const reply = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_message
       (id,author_user_id,kind,thread_root_id,body,ack_required,created_at,
        scope_project_ids,recipient_user_ids)
       VALUES ('${IDS.mismatchedReply}','${IDS.userB}','reply',
        '${IDS.scopedA}','reply',false,now(),ARRAY[]::uuid[],ARRAY[]::uuid[]);`,
    )
    expect(reply.code).not.toBe(0)
    expect(reply.stderr).toContain('board reply scope and recipients must match thread root')
  })

  test('receipt visibility and writes are limited to readers and message authors', () => {
    const own = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `SELECT count(*) FROM board_receipt WHERE message_id='${IDS.scopedA}';`,
    )
    expect(own.stdout).toBe('1')
    const author = actor(
      input,
      IDS.userA,
      [IDS.spaceA, IDS.spaceB],
      `SELECT count(*) FROM board_receipt WHERE message_id='${IDS.scopedA}';`,
    )
    expect(author.stdout).toBe('2')
    const unrelated = actor(
      input,
      IDS.userC,
      [IDS.spaceA],
      `SELECT count(*) FROM board_receipt WHERE message_id='${IDS.scopedA}';`,
    )
    expect(unrelated.stdout).toBe('0')
    const otherReader = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_receipt
       (message_id,reader_user_id,reader_session,audience_at_posting)
       VALUES ('${IDS.scopedA}','${IDS.userC}','other',true);`,
    )
    expect(otherReader.code).not.toBe(0)
    const invisible = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_receipt
       (message_id,reader_user_id,reader_session,audience_at_posting)
       VALUES ('${IDS.authorOnly}','${IDS.userB}','own',false);`,
    )
    expect(invisible.code).not.toBe(0)
  })

  test('claims are visible to project members and writable only by writing members', () => {
    expect(
      actor(
        input,
        IDS.userB,
        [IDS.spaceA],
        `SELECT count(*) FROM board_claim WHERE id='${IDS.claimA}';`,
      ).stdout,
    ).toBe('1')
    expect(
      actor(
        input,
        IDS.userD,
        [IDS.spaceA],
        `SELECT count(*) FROM board_claim WHERE id='${IDS.claimA}';`,
      ).stdout,
    ).toBe('0')
    const readInsert = actor(
      input,
      IDS.userC,
      [IDS.spaceA],
      `INSERT INTO board_claim
       (id,project_id,subject_kind,subject_value,holder_user_id,duration_ms,taken_at,
        renewed_at,lapses_at)
       VALUES ('02990000-0000-7000-8000-000000000013','${IDS.projectA}','path','read',
        '${IDS.userC}',60000,now(),now(),now() + interval '1 minute');`,
    )
    expect(readInsert.code).not.toBe(0)
    const readUpdate = actor(
      input,
      IDS.userC,
      [IDS.spaceA],
      `UPDATE board_claim SET note='read' WHERE id='${IDS.claimA}';`,
    )
    expect(readUpdate.code, readUpdate.stderr).toBe(0)
    expect(readUpdate.stdout).toBe('')
    expect(input.admin(`SELECT note IS NULL FROM board_claim WHERE id='${IDS.claimA}';`)).toBe('t')
    const writerTake = actor(
      input,
      IDS.userB,
      [IDS.spaceA],
      `INSERT INTO board_claim
       (id,project_id,subject_kind,subject_value,holder_user_id,duration_ms,taken_at,
        renewed_at,lapses_at)
       VALUES ('${IDS.claimB}','${IDS.projectA}','path','writer','${IDS.userB}',60000,
        now(),now(),now() + interval '1 minute');`,
    )
    expect(writerTake.code, writerTake.stderr).toBe(0)
    const otherWriterUpdate = actor(
      input,
      IDS.userA,
      [IDS.spaceA, IDS.spaceB],
      `UPDATE board_claim SET note='other writer' WHERE id='${IDS.claimB}' RETURNING note;`,
    )
    expect(otherWriterUpdate.code, otherWriterUpdate.stderr).toBe(0)
    expect(otherWriterUpdate.stdout).toBe('other writer')
  })

  test('the reporting role has SELECT grants but board RLS exposes no rows and no writes', () => {
    const grants = input.admin(`SELECT
      has_table_privilege('${input.readerRole}','board_message','SELECT'),
      has_table_privilege('${input.readerRole}','board_message','INSERT'),
      has_table_privilege('${input.readerRole}','board_message_tag','SELECT'),
      has_table_privilege('${input.readerRole}','board_receipt','SELECT'),
      has_table_privilege('${input.readerRole}','board_claim','SELECT');`)
    expect(grants).toBe('t|f|t|t|t')
    const read = input.psql(
      input.readerRole,
      'reader-password',
      'SELECT count(*) FROM board_message; SELECT count(*) FROM board_claim;',
    )
    expect(read.code, read.stderr).toBe(0)
    expect(read.stdout.split('\n')).toEqual(['0', '0'])
  })

  test('board message revision strictly increases across inserts and updates', () => {
    const result = actor(
      input,
      IDS.userA,
      [IDS.spaceA, IDS.spaceB],
      `INSERT INTO board_message
       (id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at)
       VALUES
        ('${IDS.revisionA}','${IDS.userA}','notice','architects','revision-a','a',false,
          now() + interval '1 hour',now()),
        ('${IDS.revisionB}','${IDS.userA}','notice','architects','revision-b','b',false,
          now() + interval '1 hour',now());
       SELECT revision FROM board_message
       WHERE id IN ('${IDS.revisionA}','${IDS.revisionB}') ORDER BY revision;
       UPDATE board_message SET body='updated' WHERE id='${IDS.revisionA}';
       SELECT revision FROM board_message WHERE id='${IDS.revisionA}';`,
    )
    expect(result.code, result.stderr).toBe(0)
    const revisions = result.stdout.split('\n').map(BigInt)
    expect(revisions[0]! < revisions[1]!).toBe(true)
    expect(revisions[1]! < revisions[2]!).toBe(true)
  })
}
