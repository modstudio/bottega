import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { bearerHeaders } from '../src/record/record-auth.ts'
import {
  SIGN_UP_AUTH,
  SIGN_UP_CLI_OUTPUT,
  testRecordAuth,
} from './fixtures/record-auth-postgres.ts'

export function registerConfigAccessSpaceCreationProof(input: {
  actorUrl: () => string
  authUrl: () => string
  token: () => string
  otherToken: () => string
  userId: () => string
  otherUserId: () => string
  cliOutput: () => string[]
  succeeds: (source: string) => string
  apiUrl: () => string
}): void {
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

  test('withdraw endpoint revokes only the member machines, returns exposed names, and refuses owners and non-holders', async () => {
    const spaceId = input.succeeds(
      `SELECT space_id FROM membership WHERE user_id='${input.userId()}' AND role='owner' ORDER BY created_at LIMIT 1;`,
    )
    const memberKey = 'WWWWWWWWWWWWWWWWWWWWWW'
    const ownerKey = 'XXXXXXXXXXXXXXXXXXXXXX'
    const otherSpaceKey = 'YYYYYYYYYYYYYYYYYYYYYY'
    const dekId = newRecordId()
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
      VALUES ('${newRecordId()}','${spaceId}','${dekId}','${memberKey}','${ownerKey}',decode('01','hex'),decode('02','hex'),now());`)
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
    const withdrawn = await request(SIGN_UP_AUTH.emailB)
    expect(withdrawn.status).toBe(200)
    expect(await withdrawn.json()).toEqual({
      revokedMachineKeyIds: [memberKey],
      readableSecretKeys: ['DEVELOPMENT_TOKEN'],
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
    expect(await revokedRead.text()).toContain('revoked because its owner lost config access')
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
