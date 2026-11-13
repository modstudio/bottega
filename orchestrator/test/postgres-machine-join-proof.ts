import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { bearerHeaders } from '../src/record/record-auth.ts'

type ProofInput = {
  apiUrl(): string
  token(): string
  otherToken(): string
  userId(): string
  otherUserId(): string
  succeeds(source: string): string
}

const SIDE_A = '11111111111111111111111111111111'
const SIDE_B = '22222222222222222222222222222222'
const SIDE_C = '33333333333333333333333333333333'

export function registerMachineJoinProof(input: ProofInput): void {
  test('machine join relays two sides and enforces lifetime, crowding, failure, limits and pruning', async () => {
    const spaceId = newRecordId()
    const headers = (token: string, space = spaceId) => ({
      ...Object.fromEntries(bearerHeaders(token)),
      'content-type': 'application/json',
      'x-record-space': space,
    })
    const request = (token: string, path: string, init: RequestInit = {}, space = spaceId) =>
      fetch(`${input.apiUrl()}${path}`, { ...init, headers: headers(token, space) })
    const allocate = async (token = input.token()) => {
      const response = await request(token, '/v1/config/join/nameplates', {
        method: 'POST',
        body: '{}',
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { nameplate: string; expiresAt: string }
    }
    const post = (
      nameplate: string,
      side: string,
      phase: string,
      body: string,
      token = input.token(),
      space = spaceId,
    ) =>
      request(
        token,
        `/v1/config/join/nameplates/${nameplate}/messages`,
        { method: 'POST', body: JSON.stringify({ side, phase, body }) },
        space,
      )
    const fail = (nameplate: string, side: string, token = input.token()) =>
      request(token, `/v1/config/join/nameplates/${nameplate}/failure`, {
        method: 'POST',
        body: JSON.stringify({ side }),
      })

    input.succeeds(`
      INSERT INTO space (id,name,slug,created_at)
      VALUES ('${spaceId}','Machine join proof','machine-join-${spaceId.slice(-8)}',now());
      INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at) VALUES
        ('${newRecordId()}','${spaceId}','${input.userId()}','owner','write',true,now()),
        ('${newRecordId()}','${spaceId}','${input.otherUserId()}','member','write',true,now());
    `)
    try {
      const exchange = await allocate()
      expect((await post(exchange.nameplate, SIDE_A, 'share', 'AQ')).status).toBe(200)
      expect(
        (await post(exchange.nameplate, SIDE_B, 'share', 'Ag', input.otherToken())).status,
      ).toBe(200)
      const fromA = await request(
        input.token(),
        `/v1/config/join/nameplates/${exchange.nameplate}/messages?side=${SIDE_A}`,
      )
      expect(await fromA.json()).toEqual({
        expiresAt: exchange.expiresAt,
        messages: [{ side: SIDE_B, phase: 'share', body: 'Ag' }],
      })
      const fromB = await request(
        input.otherToken(),
        `/v1/config/join/nameplates/${exchange.nameplate}/messages?side=${SIDE_B}`,
      )
      expect(await fromB.json()).toEqual({
        expiresAt: exchange.expiresAt,
        messages: [{ side: SIDE_A, phase: 'share', body: 'AQ' }],
      })
      expect((await post(exchange.nameplate, SIDE_C, 'share', 'Aw')).status).toBe(409)

      const expired = await allocate()
      input.succeeds(
        `UPDATE machine_join_nameplate SET expires_at=now() - interval '1 second' WHERE space_id='${spaceId}' AND nameplate='${expired.nameplate}';`,
      )
      expect((await post(expired.nameplate, SIDE_A, 'share', 'AQ')).status).toBe(410)

      const burned = await allocate()
      expect((await fail(burned.nameplate, SIDE_A)).status).toBe(200)
      expect((await fail(burned.nameplate, SIDE_A)).status).toBe(200)
      expect((await post(burned.nameplate, SIDE_A, 'share', 'AQ')).status).toBe(410)

      const otherSpace = newRecordId()
      input.succeeds(`
        INSERT INTO space (id,name,slug,created_at)
        VALUES ('${otherSpace}','Machine join other','machine-join-other-${otherSpace.slice(-8)}',now());
        INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at)
        VALUES ('${newRecordId()}','${otherSpace}','${input.userId()}','owner','write',true,now());
      `)
      expect(
        (await post(exchange.nameplate, SIDE_A, 'other-space', 'AQ', input.token(), otherSpace))
          .status,
      ).toBe(404)
      input.succeeds(
        `DELETE FROM membership WHERE space_id='${otherSpace}'; DELETE FROM space WHERE id='${otherSpace}';`,
      )

      const allocations = Number(
        input.succeeds(
          `SELECT count(*) FROM machine_join_nameplate WHERE allocated_by='${input.userId()}' AND created_at >= now() - interval '1 hour';`,
        ),
      )
      for (let index = allocations; index < 20; index += 1) await allocate()
      expect(
        (
          await request(input.token(), '/v1/config/join/nameplates', {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(429)

      for (let index = 0; index < 5; index += 1) {
        const nameplate = String(100_000 + index)
        input.succeeds(`
          INSERT INTO machine_join_nameplate (id,space_id,nameplate,allocated_by,created_at,expires_at)
          VALUES ('${newRecordId()}','${spaceId}','${nameplate}','${input.userId()}',now(),now() + interval '10 minutes');
        `)
        expect((await post(nameplate, SIDE_B, 'share', 'AQ', input.otherToken())).status).toBe(200)
        expect((await fail(nameplate, SIDE_A)).status).toBe(200)
      }
      expect(
        (
          await request(input.otherToken(), '/v1/config/join/nameplates', {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(429)

      const oldId = newRecordId()
      const liveChallenge = newRecordId()
      const expiredChallenge = newRecordId()
      const keyId = 'JOINPRUNEPROOFKEY00001'
      input.succeeds(`
        INSERT INTO machine_join_nameplate (id,space_id,nameplate,allocated_by,created_at,expires_at)
        VALUES ('${oldId}','${spaceId}','999999','${input.userId()}',now() - interval '61 minutes',now() - interval '51 minutes');
        INSERT INTO machine_public_key (id,space_id,user_id,key_id,public_key,label,created_at)
        VALUES ('${newRecordId()}','${spaceId}','${input.userId()}','${keyId}',decode(repeat('01',32),'hex'),'join prune',now());
        INSERT INTO machine_key_claim_challenge (id,space_id,key_id,user_id,nonce_hash,expires_at,created_at) VALUES
          ('${expiredChallenge}','${spaceId}','${keyId}','${input.userId()}',decode(repeat('02',32),'hex'),now() - interval '1 second',now()),
          ('${liveChallenge}','${spaceId}','${keyId}','${input.userId()}',decode(repeat('03',32),'hex'),now() + interval '1 hour',now());
        SELECT machine_join_prune();
        SELECT machine_key_claim_challenge_prune();
      `)
      expect(
        input.succeeds(
          `SELECT count(*) FROM machine_join_nameplate WHERE id='${oldId}'; SELECT string_agg(id::text, ',') FROM machine_key_claim_challenge WHERE id IN ('${expiredChallenge}','${liveChallenge}');`,
        ),
      ).toBe(`0\n${liveChallenge}`)
    } finally {
      input.succeeds(`
        DELETE FROM machine_key_claim_challenge WHERE space_id='${spaceId}';
        DELETE FROM machine_join_message WHERE space_id='${spaceId}';
        DELETE FROM machine_join_nameplate WHERE space_id='${spaceId}';
        DELETE FROM machine_public_key WHERE space_id='${spaceId}';
        DELETE FROM membership WHERE space_id='${spaceId}';
        DELETE FROM space WHERE id='${spaceId}';
      `)
    }
  })
}
