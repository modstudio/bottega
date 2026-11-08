import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { bearerHeaders, setActiveRecordSpaceForSession } from '../src/record/record-auth.ts'
import {
  SIGN_UP_AUTH,
  SIGN_UP_CLI_OUTPUT,
  testRecordAuth,
} from './fixtures/record-auth-postgres.ts'
import { registerTrialSpaceTeardownProof } from './postgres-trial-space-teardown-proof.ts'

export function registerConfigAccessSpaceCreationProof(input: {
  actorUrl: () => string
  authUrl: () => string
  token: () => string
  otherToken: () => string
  userId: () => string
  otherUserId: () => string
  cliOutput: () => string[]
  succeeds: (source: string) => string
  psql: (
    source: string,
    user?: string,
    password?: string,
  ) => {
    code: number
    stdout: string
    stderr: string
  }
  apiUrl: () => string
}): void {
  registerTrialSpaceTeardownProof({
    actorUrl: input.actorUrl,
    admin: input.succeeds,
    psql: (user, password, source) => input.psql(source, user, password),
  })
  test('CLI sign-up creates owner memberships with config access and distinct identities', async () => {
    expect(input.cliOutput()).toEqual(SIGN_UP_CLI_OUTPUT)
    expect(
      input
        .succeeds(
          `SELECT u.email, count(m.id), min(m.role), min(m.permission), bool_and(m.config_access)
         FROM "user" u JOIN membership m ON m.user_id=u.id
         WHERE u.id IN ('${input.userId()}', '${input.otherUserId()}')
         GROUP BY u.email ORDER BY u.email;`,
        )
        .split('\n'),
    ).toEqual([`${SIGN_UP_AUTH.emailA}|1|owner|write|t`, `${SIGN_UP_AUTH.emailB}|1|owner|write|t`])
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    try {
      expect((await auth.api.getSession({ headers: bearerHeaders(input.token()) }))?.user.id).toBe(
        input.userId(),
      )
      expect(
        (await auth.api.getSession({ headers: bearerHeaders(input.otherToken()) }))?.user.id,
      ).toBe(input.otherUserId())
    } finally {
      await auth.close()
    }
  })

  test('afterCreateOrganization grants config access to the creating owner', async () => {
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    try {
      const userId = input.userId()
      const created = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: 'Config Access Hook',
          slug: `config-access-hook-${userId.slice(-8)}`,
          keepCurrentActiveOrganization: true,
        },
      })
      expect(
        input.succeeds(
          `SELECT role, permission, config_access
           FROM membership WHERE space_id='${created.id}' AND user_id='${userId}';`,
        ),
      ).toBe('owner|write|t')
    } finally {
      await auth.close()
    }
  })

  test('a read member promoted to owner gains write permission', async () => {
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    const memberId = newRecordId()
    try {
      const userId = input.userId()
      const created = await auth.api.createOrganization({
        headers: bearerHeaders(input.token()),
        body: {
          name: 'Owner Write Hook',
          slug: `owner-write-hook-${userId.slice(-8)}`,
          keepCurrentActiveOrganization: true,
        },
      })
      input.succeeds(`
        INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at)
        VALUES ('${memberId}','${created.id}','${input.otherUserId()}','member','read',false,now());`)
      await auth.api.updateMemberRole({
        headers: bearerHeaders(input.token()),
        body: { memberId, role: 'owner', organizationId: created.id },
      })
      expect(
        input.succeeds(`SELECT role, permission FROM membership WHERE id='${memberId}';`),
      ).toBe('owner|write')
    } finally {
      input.succeeds(`DELETE FROM membership WHERE id='${memberId}';`)
      await auth.close()
    }
  })

  test('a non-owner member setting the outside intake receives the owner remedy', async () => {
    const spaceId = newRecordId()
    const projectId = newRecordId()
    const headers = bearerHeaders(input.otherToken())
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    const previous = await auth.api.getSession({ headers })
    const previousSpaceId = previous?.session.activeOrganizationId
    if (!previousSpaceId) throw new Error('outside intake proof user has no active space')
    try {
      input.succeeds(`
        INSERT INTO space (id,name,slug,created_at)
        VALUES ('${spaceId}','Outside intake owner proof','outside-intake-${spaceId.slice(-8)}',now());
        INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
          ('${newRecordId()}','${spaceId}','${input.userId()}','owner','write',now()),
          ('${newRecordId()}','${spaceId}','${input.otherUserId()}','member','write',now());
        INSERT INTO project (id,space_id,name,key_prefixes,created_at)
        VALUES ('${projectId}','${spaceId}','outside-intake-proof',ARRAY['OIP'],now());`)
      await setActiveRecordSpaceForSession(input.actorUrl(), headers, spaceId)
      const response = await fetch(`${input.apiUrl()}/v1/outside-intake`, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(headers),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ project: 'outside-intake-proof' }),
      })
      expect(response.status).toBe(403)
      expect(await response.text()).toContain(
        'setting the outside intake requires the active space owner; switch to an owned space and retry',
      )
      expect(
        input.succeeds(`SELECT count(*) FROM space_outside_intake WHERE space_id='${spaceId}';`),
      ).toBe('0')
    } finally {
      try {
        await setActiveRecordSpaceForSession(input.actorUrl(), headers, previousSpaceId)
      } finally {
        input.succeeds(`
          DELETE FROM space_outside_intake WHERE space_id='${spaceId}';
          DELETE FROM project WHERE id='${projectId}';
          DELETE FROM membership WHERE space_id='${spaceId}';
          DELETE FROM space WHERE id='${spaceId}';`)
        await auth.close()
      }
    }
  })

  test('membership removal ignores a DEK held only by an unattributed key when the member held no wrap', () => {
    const spaceId = newRecordId()
    const membershipId = newRecordId()
    const dekId = newRecordId()
    const keyId = 'UNATTRIBUTED_ONLY_WRAP'
    expect(
      input.succeeds(`
        BEGIN;
        INSERT INTO space (id,name,slug,created_at)
        VALUES ('${spaceId}','Unattributed-only wrap','unattributed-only-${spaceId.slice(-8)}',now());
        INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at) VALUES
          ('${newRecordId()}','${spaceId}','${input.userId()}','owner','write',true,now()),
          ('${membershipId}','${spaceId}','${input.otherUserId()}','member','write',true,now());
        INSERT INTO secret_dek (id,space_id,version,created_at)
        VALUES ('${dekId}','${spaceId}',1,now());
        INSERT INTO config_secret (id,space_id,user_id,key,environment,dek_id,row_version,envelope,updated_at)
        VALUES ('${newRecordId()}','${spaceId}',NULL,'UNATTRIBUTED_ONLY','default','${dekId}',1,decode('01','hex'),now());
        INSERT INTO machine_public_key (id,space_id,user_id,key_id,public_key,label,created_at)
        VALUES ('${newRecordId()}','${spaceId}',NULL,'${keyId}',decode(repeat('55',32),'hex'),'unattributed-only',now());
        INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
        VALUES ('${newRecordId()}','${spaceId}','${dekId}','${keyId}','${keyId}',decode('02','hex'),decode('03','hex'),now());
        DELETE FROM membership WHERE id='${membershipId}';
        SELECT
          (SELECT count(*) FROM membership WHERE id='${membershipId}'),
          (SELECT revoked_at IS NULL FROM machine_public_key WHERE space_id='${spaceId}' AND key_id='${keyId}'),
          (SELECT count(*) FROM secret_dek_wrap WHERE space_id='${spaceId}' AND dek_id='${dekId}');
        ROLLBACK;`),
    ).toBe('0|t|1')
  })

  test('withdraw endpoint revokes only the member machines, returns exposed names, and refuses owners and non-holders', async () => {
    const spaceId = input.succeeds(
      `SELECT space_id FROM membership WHERE user_id='${input.userId()}' AND role='owner' ORDER BY created_at LIMIT 1;`,
    )
    const memberKey = 'WWWWWWWWWWWWWWWWWWWWWW'
    const ownerKey = 'XXXXXXXXXXXXXXXXXXXXXX'
    const otherSpaceKey = 'YYYYYYYYYYYYYYYYYYYYYY'
    const unattributedKey = 'ZZZZZZZZZZZZZZZZZZZZZZ'
    const dekId = newRecordId()
    const strandedDekId = newRecordId()
    input.succeeds(`
      INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at)
      VALUES ('${newRecordId()}','${spaceId}','${input.otherUserId()}','member','write',true,now());
      INSERT INTO secret_dek (id,space_id,version,created_at)
      VALUES ('${dekId}','${spaceId}',1,now());
      INSERT INTO config_secret (id,space_id,user_id,key,environment,dek_id,row_version,envelope,updated_at)
      VALUES ('${newRecordId()}','${spaceId}',NULL,'DEVELOPMENT_TOKEN','default','${dekId}',1,decode('01','hex'),now());
      INSERT INTO machine_public_key (id,space_id,user_id,key_id,public_key,label,created_at) VALUES
        ('${newRecordId()}','${spaceId}','${input.otherUserId()}','${memberKey}',decode(repeat('11',32),'hex'),'member',now()),
        ('${newRecordId()}','${spaceId}','${input.userId()}','${ownerKey}',decode(repeat('22',32),'hex'),'owner',now()),
        ('${newRecordId()}',(SELECT space_id FROM membership WHERE user_id='${input.otherUserId()}' AND role='owner' LIMIT 1),'${input.otherUserId()}','${otherSpaceKey}',decode(repeat('33',32),'hex'),'other-space',now());
      INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
      VALUES
        ('${newRecordId()}','${spaceId}','${dekId}','${memberKey}','${ownerKey}',decode('01','hex'),decode('02','hex'),now()),
        ('${newRecordId()}','${spaceId}','${dekId}','${ownerKey}','${ownerKey}',decode('03','hex'),decode('04','hex'),now());`)
    const request = (email: string) =>
      fetch(`${input.apiUrl()}/v1/config-access/withdraw`, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(bearerHeaders(input.token())),
          'content-type': 'application/json',
          'x-record-space': spaceId,
        },
        body: JSON.stringify({ email }),
      })
    const owner = await request(SIGN_UP_AUTH.emailA)
    expect(owner.status).toBe(422)
    expect(await owner.text()).toContain('change their role first')

    input.succeeds(`
      INSERT INTO machine_public_key (id,space_id,user_id,key_id,public_key,label,created_at)
      VALUES ('${newRecordId()}','${spaceId}',NULL,'${unattributedKey}',decode(repeat('44',32),'hex'),'unattributed',now());
      INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
      VALUES ('${newRecordId()}','${spaceId}','${dekId}','${unattributedKey}','${ownerKey}',decode('05','hex'),decode('06','hex'),now());`)
    const unattributed = await request(SIGN_UP_AUTH.emailB)
    expect(unattributed.status).toBe(409)
    const unattributedText = await unattributed.text()
    expect(unattributedText).toContain(unattributedKey)
    expect(unattributedText).toContain('machine config machine init')
    expect(
      input.succeeds(
        `SELECT config_access FROM membership WHERE space_id='${spaceId}' AND user_id='${input.otherUserId()}';`,
      ),
    ).toBe('t')
    input.succeeds(`
      UPDATE machine_public_key SET revoked_at=now() WHERE space_id='${spaceId}' AND key_id='${unattributedKey}';
      DELETE FROM secret_dek_wrap WHERE space_id='${spaceId}' AND recipient_key_id='${unattributedKey}';
      INSERT INTO secret_dek (id,space_id,version,created_at) VALUES ('${strandedDekId}','${spaceId}',2,now());
      INSERT INTO config_secret (id,space_id,user_id,key,environment,dek_id,row_version,envelope,updated_at)
      VALUES ('${newRecordId()}','${spaceId}',NULL,'ONLY_MEMBER_CAN_OPEN','default','${strandedDekId}',1,decode('07','hex'),now());
      INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
      VALUES ('${newRecordId()}','${spaceId}','${strandedDekId}','${memberKey}','${ownerKey}',decode('08','hex'),decode('09','hex'),now());`)
    const stranded = await request(SIGN_UP_AUTH.emailB)
    expect(stranded.status).toBe(409)
    const strandedText = await stranded.text()
    expect(strandedText).toContain('data key versions: 2')
    expect(strandedText).toContain('machine config machine trust')
    expect(
      input.succeeds(
        `SELECT m.config_access, k.revoked_at IS NULL,
          (SELECT count(*) FROM secret_dek_wrap WHERE dek_id='${strandedDekId}')
         FROM membership m JOIN machine_public_key k
           ON k.space_id=m.space_id AND k.user_id=m.user_id
         WHERE m.space_id='${spaceId}' AND m.user_id='${input.otherUserId()}' AND k.key_id='${memberKey}';`,
      ),
    ).toBe('t|t|1')
    const direct = input.psql(
      `UPDATE membership SET config_access=false WHERE space_id='${spaceId}' AND user_id='${input.otherUserId()}';`,
    )
    expect(direct.code).not.toBe(0)
    expect(direct.stderr).toContain('strand data key versions: 2')
    input.succeeds(`
      INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
      VALUES ('${newRecordId()}','${spaceId}','${strandedDekId}','${ownerKey}','${ownerKey}',decode('0a','hex'),decode('0b','hex'),now());`)
    const withdrawn = await request(SIGN_UP_AUTH.emailB)
    expect(withdrawn.status).toBe(200)
    expect(await withdrawn.json()).toEqual({
      revokedMachineKeyIds: [memberKey],
      readableSecretKeys: ['DEVELOPMENT_TOKEN', 'ONLY_MEMBER_CAN_OPEN'],
    })
    expect(
      input.succeeds(
        `SELECT key_id, revoked_at IS NOT NULL FROM machine_public_key
         WHERE key_id IN ('${memberKey}','${ownerKey}','${otherSpaceKey}') ORDER BY key_id;
         SELECT count(*) FROM secret_dek_wrap WHERE recipient_key_id='${memberKey}';`,
      ),
    ).toBe(`${memberKey}|t\n${ownerKey}|f\n${otherSpaceKey}|f\n0`)
    const revokedRead = await fetch(
      `${input.apiUrl()}/v1/config/data-keys/current?recipientKeyId=${memberKey}`,
      {
        headers: {
          ...Object.fromEntries(bearerHeaders(input.otherToken())),
          'x-record-space': spaceId,
        },
      },
    )
    expect(revokedRead.status).toBe(422)
    expect(await revokedRead.text()).toContain("this machine's key is revoked in the space")
    const repeated = await request(SIGN_UP_AUTH.emailB)
    expect(repeated.status).toBe(422)
    expect(await repeated.text()).toContain('does not have config access')

    input.succeeds(`UPDATE membership SET config_access=true
      WHERE space_id='${spaceId}' AND user_id='${input.otherUserId()}';`)
    const regrantedRead = await fetch(
      `${input.apiUrl()}/v1/config/data-keys/current?recipientKeyId=${memberKey}`,
      {
        headers: {
          ...Object.fromEntries(bearerHeaders(input.otherToken())),
          'x-record-space': spaceId,
        },
      },
    )
    expect(regrantedRead.status).toBe(422)
    expect(await regrantedRead.text()).toContain('machine config machine init')

    input.succeeds(`
      UPDATE machine_public_key SET revoked_at=NULL WHERE space_id='${spaceId}' AND key_id='${memberKey}';
      INSERT INTO secret_dek_wrap (id,space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at)
      VALUES ('${newRecordId()}','${spaceId}','${dekId}','${memberKey}','${ownerKey}',decode('01','hex'),decode('02','hex'),now());`)
    const auth = testRecordAuth(input.actorUrl(), input.authUrl())
    try {
      await auth.api.removeMember({
        headers: bearerHeaders(input.token()),
        body: { memberIdOrEmail: SIGN_UP_AUTH.emailB, organizationId: spaceId },
      })
    } finally {
      await auth.close()
    }
    expect(
      input.succeeds(
        `SELECT revoked_at IS NOT NULL FROM machine_public_key WHERE space_id='${spaceId}' AND key_id='${memberKey}';
         SELECT count(*) FROM secret_dek_wrap WHERE recipient_key_id='${memberKey}';`,
      ),
    ).toBe('t\n0')
  })
}
