import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configClient, type ConfigClient } from '../../shared/config-client.ts'
import {
  CONFIG_HOME_ENV,
  HARNESS_ENV_FILE_ENV,
  type ConfigEnvironment,
} from '../../shared/config-directory.ts'
import { openHostedSecret } from '../../shared/hosted-secret-opening.ts'
import { KEYSTORE_ENV } from '../../shared/key-store-constants.ts'
import { machineKeyId } from '../../shared/machine-key-id.ts'
import { readMachineKey } from '../../shared/machine-key-store.ts'
import {
  generateMachineSigningKeyPair,
  readMachineSigningKey,
} from '../../shared/machine-signing-key.ts'
import {
  formatPairingCode,
  generatePairingCode,
  parsePairingCode,
} from '../../shared/pairing-code.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  wrapDataKey,
} from '../../shared/secret-envelope.ts'
import { readTrustList } from '../../shared/trust-list.ts'
import { signTrustLogEntry, trustLogEntryHash, type TrustLogKey } from '../../shared/trust-log.ts'
import { writeRememberedTrustLogHead } from '../../shared/trust-log-head.ts'
import { machineInit } from '../src/config/config-service.ts'
import { encoded } from '../src/config/data-key-access.ts'
import { machineApprove, machineJoin } from '../src/config/machine-join.ts'
import { bearerHeaders } from '../src/record/record-auth.ts'

type ProofInput = {
  apiUrl(): string
  token(): string
  otherToken(): string
  userId(): string
  otherUserId(): string
  succeeds(source: string): string
}

type ProofMachine = {
  client: ConfigClient
  env: ConfigEnvironment
  key: NonNullable<ReturnType<typeof readMachineKey>>
  signing: NonNullable<ReturnType<typeof readMachineSigningKey>>
  keyId: string
  label: string
}

type ServiceFixture = {
  approver: ProofMachine
  joiner: ProofMachine
  genesisHead: Uint8Array
  selected: { spaceId: string; slug: string }
  roots: string[]
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
    const read = (nameplate: string, side: string) =>
      request(input.token(), `/v1/config/join/nameplates/${nameplate}/messages?side=${side}`)
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
      expect((await read(expired.nameplate, SIDE_A)).status).toBe(410)

      const burned = await allocate()
      expect((await fail(burned.nameplate, SIDE_A)).status).toBe(200)
      expect((await fail(burned.nameplate, SIDE_A)).status).toBe(200)
      expect((await post(burned.nameplate, SIDE_A, 'share', 'AQ')).status).toBe(410)
      expect((await read(burned.nameplate, SIDE_A)).status).toBe(410)

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
        expect((await fail(nameplate, SIDE_B, input.otherToken())).status).toBe(200)
      }
      const refusedFailureNameplate = '100005'
      input.succeeds(`
        INSERT INTO machine_join_nameplate (id,space_id,nameplate,allocated_by,created_at,expires_at)
        VALUES ('${newRecordId()}','${spaceId}','${refusedFailureNameplate}','${input.userId()}',now(),now() + interval '10 minutes');
      `)
      expect((await fail(refusedFailureNameplate, SIDE_B, input.otherToken())).status).toBe(429)
      expect(
        input.succeeds(
          `SELECT count(*) FROM machine_join_nameplate WHERE space_id='${spaceId}' AND nameplate='${refusedFailureNameplate}' AND failed_at IS NULL;`,
        ),
      ).toBe('1')
      expect(
        (
          await request(input.otherToken(), '/v1/config/join/nameplates', {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(429)
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

  const machineEnv = (root: string): ConfigEnvironment => ({
    [CONFIG_HOME_ENV]: root,
    [HARNESS_ENV_FILE_ENV]: '',
    [KEYSTORE_ENV]: 'file',
    BOTTEGA_RECORD_API_URL: input.apiUrl(),
  })

  const deleteFixture = (fixture: ServiceFixture) => {
    const { spaceId } = fixture.selected
    input.succeeds(`
      DELETE FROM config_secret WHERE space_id='${spaceId}';
      DELETE FROM secret_dek_wrap WHERE space_id='${spaceId}';
      DELETE FROM secret_dek WHERE space_id='${spaceId}';
      DELETE FROM machine_key_claim_challenge WHERE space_id='${spaceId}';
      DELETE FROM machine_join_message WHERE space_id='${spaceId}';
      DELETE FROM machine_join_nameplate WHERE space_id='${spaceId}';
      DELETE FROM machine_trust_log WHERE space_id='${spaceId}';
      DELETE FROM machine_public_key WHERE space_id='${spaceId}';
      DELETE FROM membership WHERE space_id='${spaceId}';
      DELETE FROM space WHERE id='${spaceId}';
    `)
    for (const root of fixture.roots) rmSync(root, { recursive: true, force: true })
  }

  const setupFixture = async (suffix: string): Promise<ServiceFixture> => {
    const spaceId = newRecordId()
    const slug = `machine-join-service-${suffix}-${spaceId.slice(-6)}`
    input.succeeds(`
      INSERT INTO space (id,name,slug,created_at)
      VALUES ('${spaceId}','Machine join service ${suffix}','${slug}',now());
      INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at) VALUES
        ('${newRecordId()}','${spaceId}','${input.userId()}','owner','write',true,now()),
        ('${newRecordId()}','${spaceId}','${input.otherUserId()}','member','write',true,now());
    `)
    const roots = [
      mkdtempSync(join(tmpdir(), 'bottega-machine-approve-')),
      mkdtempSync(join(tmpdir(), 'bottega-machine-join-')),
    ]
    const selected = { spaceId, slug }
    const createMachine = async (
      root: string,
      token: string,
      label: string,
    ): Promise<ProofMachine> => {
      const env = machineEnv(root)
      const client = configClient(env, fetch, token)
      const keyId = await machineInit(spaceId, label, client, env)
      return {
        client,
        env,
        key: readMachineKey(env)!,
        signing: readMachineSigningKey(env)!,
        keyId,
        label,
      }
    }
    const approver = await createMachine(roots[0]!, input.token(), `approver-${suffix}`)
    const joiner = await createMachine(roots[1]!, input.otherToken(), `joiner-${suffix}`)
    const genesis = signTrustLogEntry(
      {
        prev: null,
        space: spaceId,
        body: {
          kind: 'genesis',
          first: {
            keyId: approver.keyId,
            publicKey: approver.key.publicKey,
            signingPublicKey: approver.signing.publicKey,
            label: approver.label,
          },
          recoveryPublicKey: generateMachineSigningKeyPair().publicKey,
        },
        signer: approver.signing.publicKey,
        at: 1,
      },
      approver.signing.privateKey,
    )
    const genesisHead = await approver.client.appendTrustLogEntry(null, genesis, {
      destinationSpaceId: spaceId,
    })
    writeRememberedTrustLogHead(spaceId, genesisHead, approver.env)
    return { approver, joiner, genesisHead, selected, roots }
  }

  const beginJoin = (fixture: ServiceFixture, at?: number | (() => number)) => {
    let resolveCode!: (code: string) => void
    const code = new Promise<string>((resolve) => {
      resolveCode = resolve
    })
    let printed = false
    const result = machineJoin(fixture.selected, {
      client: fixture.joiner.client,
      env: fixture.joiner.env,
      pollMs: 10,
      at,
      output: (line) => {
        if (!printed) {
          printed = true
          resolveCode(line)
        }
      },
    })
    return { code, result }
  }

  const approve = (fixture: ServiceFixture, code: string) =>
    machineApprove(code, fixture.selected, {
      client: fixture.approver.client,
      env: fixture.approver.env,
      pollMs: 10,
    })

  test('one machine approval lets the joining machine open an approver-sealed secret', async () => {
    const fixture = await setupFixture('open')
    try {
      const destination = { destinationSpaceId: fixture.selected.spaceId }
      const dek = generateDataKey()
      const dekId = newRecordId()
      const wrapped = await wrapDataKey({
        dek,
        wrapContext: { spaceId: fixture.selected.spaceId, dekId, dekVersion: 1 },
        senderPrivateKey: fixture.approver.key.privateKey,
        senderPublicKey: fixture.approver.key.publicKey,
        recipientPublicKey: fixture.approver.key.publicKey,
      })
      await fixture.approver.client.createDataKey(
        {
          dekId,
          version: 1,
          wraps: [
            {
              recipientKeyId: fixture.approver.keyId,
              senderKeyId: fixture.approver.keyId,
              enc: encoded(wrapped.enc),
              ciphertext: encoded(wrapped.ciphertext),
            },
          ],
        },
        destination,
      )
      const envelope = sealValue({
        dek,
        plaintext: new TextEncoder().encode('approved secret'),
        valueContext: {
          spaceId: fixture.selected.spaceId,
          userId: null,
          keyName: 'proof',
          environment: 'default',
          dekId,
          rowVersion: 1,
        },
      })
      await fixture.approver.client.putSecret('proof', {
        ...destination,
        scope: 'space',
        environment: 'default',
        dekId,
        envelope: encoded(envelope),
        expectedRowVersion: null,
      })

      const joining = beginJoin(fixture)
      const code = await joining.code
      const [joined, approved] = await Promise.all([joining.result, approve(fixture, code)])
      expect(joined).toEqual({ label: fixture.approver.label, keyId: fixture.approver.keyId })
      expect(approved).toEqual({ label: fixture.joiner.label, keyId: fixture.joiner.keyId })

      const row = await fixture.joiner.client.getSecret('proof', 'space', 'default', destination)
      const key = await fixture.joiner.client.getDataKey(dekId, fixture.joiner.keyId, destination)
      const plaintext = await openHostedSecret({
        row,
        key,
        machine: { ...fixture.joiner.key, keyId: fixture.joiner.keyId },
        trust: await readTrustList(fixture.joiner.env),
        expected: { key: 'proof', scope: 'space', environment: 'default' },
        identity: { spaceId: fixture.selected.spaceId, userId: input.otherUserId() },
      })
      expect(new TextDecoder().decode(plaintext)).toBe('approved secret')
    } finally {
      deleteFixture(fixture)
    }
  })

  test('an unapproved trust-log add is refused and wraps no data key', async () => {
    const fixture = await setupFixture('untrusted-add')
    try {
      const untrusted = generateMachineSigningKeyPair()
      const addedPair = await generateMachineKeyPair()
      const added: TrustLogKey = {
        keyId: await machineKeyId(addedPair.publicKey),
        publicKey: addedPair.publicKey,
        signingPublicKey: generateMachineSigningKeyPair().publicKey,
        label: 'unapproved',
      }
      const entry = signTrustLogEntry(
        {
          prev: fixture.genesisHead,
          space: fixture.selected.spaceId,
          body: { kind: 'add', ...added },
          signer: untrusted.publicKey,
          at: 2,
        },
        untrusted.privateKey,
      )
      await fixture.approver.client.appendTrustLogEntry(fixture.genesisHead, entry, {
        destinationSpaceId: fixture.selected.spaceId,
      })
      await expect(
        machineJoin(fixture.selected, {
          client: fixture.joiner.client,
          env: fixture.joiner.env,
          pollMs: 10,
        }),
      ).rejects.toThrow(/signer authority rule/)
      expect(
        input.succeeds(
          `SELECT count(*) FROM secret_dek_wrap WHERE space_id='${fixture.selected.spaceId}' AND recipient_key_id='${fixture.joiner.keyId}';`,
        ),
      ).toBe('0')
    } finally {
      deleteFixture(fixture)
    }
  })

  test('a wrong code rejects both machines, burns the nameplate, and pins neither peer', async () => {
    const fixture = await setupFixture('wrong-code')
    try {
      const beforeApprover = await readTrustList(fixture.approver.env)
      const beforeJoiner = await readTrustList(fixture.joiner.env)
      const joining = beginJoin(fixture)
      const code = await joining.code
      const parsed = parsePairingCode(code)
      const wrong = formatPairingCode({
        nameplate: parsed.nameplate,
        secret: Uint8Array.from(parsed.secret, (byte, index) => (index === 0 ? byte ^ 1 : byte)),
      })
      const [joinResult, approveResult] = await Promise.allSettled([
        joining.result,
        approve(fixture, wrong),
      ])
      expect(joinResult.status).toBe('rejected')
      expect(approveResult.status).toBe('rejected')
      if (joinResult.status === 'rejected')
        expect(String(joinResult.reason)).toMatch(
          /pairing exchange failed or expired|pairing code did not match/,
        )
      if (approveResult.status === 'rejected')
        expect(String(approveResult.reason)).toMatch(
          /pairing exchange failed or expired|pairing code did not match/,
        )
      const burned = await fetch(
        `${input.apiUrl()}/v1/config/join/nameplates/${parsed.nameplate}/messages?side=${SIDE_C}`,
        {
          headers: {
            ...Object.fromEntries(bearerHeaders(input.token())),
            'x-record-space': fixture.selected.spaceId,
          },
        },
      )
      expect(burned.status).toBe(410)
      expect(await readTrustList(fixture.approver.env)).toEqual(beforeApprover)
      expect(await readTrustList(fixture.joiner.env)).toEqual(beforeJoiner)
    } finally {
      deleteFixture(fixture)
    }
  })

  test('a third machine-join side is refused', async () => {
    const fixture = await setupFixture('third-side')
    try {
      const destination = { destinationSpaceId: fixture.selected.spaceId }
      const allocated = await fixture.approver.client.allocateMachineJoinNameplate(destination)
      await fixture.approver.client.postMachineJoinMessage(
        allocated.nameplate,
        SIDE_A,
        'pake-a',
        new Uint8Array([1]),
        destination,
      )
      await fixture.joiner.client.postMachineJoinMessage(
        allocated.nameplate,
        SIDE_B,
        'pake-b',
        new Uint8Array([2]),
        destination,
      )
      await expect(
        fixture.approver.client.postMachineJoinMessage(
          allocated.nameplate,
          SIDE_C,
          'confirm-a',
          new Uint8Array([3]),
          destination,
        ),
      ).rejects.toMatchObject({ status: 409 })
    } finally {
      deleteFixture(fixture)
    }
  })

  test('machine join refuses when its allocated nameplate is expired', async () => {
    const fixture = await setupFixture('expired')
    try {
      const joining = beginJoin(fixture, Number.MAX_SAFE_INTEGER)
      await joining.code
      await expect(joining.result).rejects.toThrow('pairing code expired; start again')
    } finally {
      deleteFixture(fixture)
    }
  })

  test('machine join refuses a trust-log fork after remembering an approved head', async () => {
    const fixture = await setupFixture('fork')
    try {
      const joining = beginJoin(fixture)
      const code = await joining.code
      await Promise.all([joining.result, approve(fixture, code)])
      const addedPair = await generateMachineKeyPair()
      const replacement = signTrustLogEntry(
        {
          prev: fixture.genesisHead,
          space: fixture.selected.spaceId,
          body: {
            kind: 'add',
            keyId: await machineKeyId(addedPair.publicKey),
            publicKey: addedPair.publicKey,
            signingPublicKey: generateMachineSigningKeyPair().publicKey,
            label: 'fork-tail',
          },
          signer: fixture.approver.signing.publicKey,
          at: 3,
        },
        fixture.approver.signing.privateKey,
      )
      const replacementHash = trustLogEntryHash(replacement)
      input.succeeds(`
        DELETE FROM machine_trust_log WHERE space_id='${fixture.selected.spaceId}' AND seq=1;
        INSERT INTO machine_trust_log (id,space_id,seq,hash,prev_hash,entry,created_at)
        VALUES ('${newRecordId()}','${fixture.selected.spaceId}',1,
          decode('${Buffer.from(replacementHash).toString('hex')}','hex'),
          decode('${Buffer.from(fixture.genesisHead).toString('hex')}','hex'),
          decode('${Buffer.from(replacement).toString('hex')}','hex'),now());
      `)
      await expect(
        machineJoin(fixture.selected, {
          client: fixture.approver.client,
          env: fixture.approver.env,
          pollMs: 10,
        }),
      ).rejects.toThrow(/trust log fork or rollback/)
    } finally {
      deleteFixture(fixture)
    }
  })
}
