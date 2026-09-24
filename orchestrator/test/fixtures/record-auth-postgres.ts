import { expect, test } from 'bun:test'
import { RECORD_AUTH_ROLE } from '../../../shared/record/schema.ts'
import { RECORD_SIGN_UP_INVITATION_REQUIRED, recordAuth } from '../../src/record/record-auth.ts'

export const SIGN_UP_AUTH = {
  emailA: 'auth-a@example.test',
  emailB: 'auth-b@example.test',
  emailRepair: 'auth-repair@example.test',
  password: 'correct-horse-battery-staple',
  repairBody: {
    email: 'auth-repair@example.test',
    name: 'Auth Repair',
    password: 'correct-horse-battery-staple',
  },
  caseEmail: 'auth-case@example.test',
  shortPasswordEmail: 'auth-short-password@example.test',
  noInvitationEmail: 'auth-no-invitation@example.test',
  expiredEmail: 'auth-expired@example.test',
  acceptedEmail: 'auth-accepted@example.test',
  invitationA: '01990000-0000-7000-8000-00000000014a',
  invitationB: '01990000-0000-7000-8000-00000000014b',
  invitationRepair: '01990000-0000-7000-8000-00000000014c',
  invitationCase: '01990000-0000-7000-8000-00000000014d',
  invitationShort: '01990000-0000-7000-8000-00000000014e',
  invitationExpired: '01990000-0000-7000-8000-00000000014f',
  invitationAccepted: '01990000-0000-7000-8000-000000000150',
} as const

export const SIGN_UP_CLI_OUTPUT = [
  `signed up ${SIGN_UP_AUTH.emailA}`,
  `signed up ${SIGN_UP_AUTH.emailB}`,
]

export function signUpInvitationFixtures(spaceId: string, inviterId: string): string {
  return `
    ('${SIGN_UP_AUTH.invitationA}','${spaceId}','${SIGN_UP_AUTH.emailA}','${inviterId}','member','pending',now() + interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationB}','${spaceId}','${SIGN_UP_AUTH.emailB}','${inviterId}','member','pending',now() + interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationRepair}','${spaceId}','${SIGN_UP_AUTH.emailRepair}','${inviterId}','member','pending',now() + interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationCase}','${spaceId}',' AUTH-CASE@EXAMPLE.TEST ','${inviterId}','member','pending',now() + interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationShort}','${spaceId}','${SIGN_UP_AUTH.shortPasswordEmail}','${inviterId}','member','pending',now() + interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationExpired}','${spaceId}','${SIGN_UP_AUTH.expiredEmail}','${inviterId}','member','pending',now() - interval '1 day',now()),
    ('${SIGN_UP_AUTH.invitationAccepted}','${spaceId}','${SIGN_UP_AUTH.acceptedEmail}','${inviterId}','member','accepted',now() + interval '1 day',now())`
}

type Query = (
  user: string,
  password: string,
  source: string,
) => {
  code: number
  stdout: string
  stderr: string
}
type Succeeds = (user: string, password: string, source: string) => string

function proveInvitationPredicate(query: Query): void {
  const eligibility = query(
    'record_actor',
    'actor-password',
    `SELECT public.invitation_open_for('${SIGN_UP_AUTH.caseEmail}');
     SELECT public.invitation_open_for('${SIGN_UP_AUTH.expiredEmail}');
     SELECT public.invitation_open_for('${SIGN_UP_AUTH.acceptedEmail}');
     SELECT count(*) FROM invitation;`,
  )
  expect(eligibility.code, eligibility.stderr).toBe(0)
  expect(eligibility.stdout.split('\n')).toEqual(['t', 'f', 'f', '0'])
}

async function proveInvitationOnlySignUp(
  actorUrl: string,
  succeeds: Succeeds,
  password: string,
): Promise<void> {
  const rejectedMessage = async (email: string, candidate = password): Promise<string> => {
    try {
      await recordAuth(actorUrl).api.signUpEmail({
        body: { email, name: 'Rejected sign-up', password: candidate },
      })
      return 'sign-up unexpectedly succeeded'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  expect(
    await Promise.all([
      rejectedMessage(SIGN_UP_AUTH.noInvitationEmail),
      rejectedMessage(SIGN_UP_AUTH.expiredEmail),
      rejectedMessage(SIGN_UP_AUTH.acceptedEmail),
    ]),
  ).toEqual([
    RECORD_SIGN_UP_INVITATION_REQUIRED,
    RECORD_SIGN_UP_INVITATION_REQUIRED,
    RECORD_SIGN_UP_INVITATION_REQUIRED,
  ])
  const accountCounts = (email: string) =>
    succeeds(
      'postgres',
      'postgres',
      `SELECT (SELECT count(*) FROM "user" WHERE email='${email}') || '|' ||
        (SELECT count(*) FROM account a JOIN "user" u ON u.id=a.user_id
         WHERE u.email='${email}');`,
    )
  expect(accountCounts(SIGN_UP_AUTH.noInvitationEmail)).toBe('0|0')
  await expect(
    recordAuth(actorUrl).api.signUpEmail({
      body: { email: SIGN_UP_AUTH.caseEmail, name: 'Case Match', password },
    }),
  ).resolves.toMatchObject({ user: { email: SIGN_UP_AUTH.caseEmail } })
  expect(await rejectedMessage(SIGN_UP_AUTH.shortPasswordEmail, 'elevenchars')).toBe(
    'Password too short',
  )
  expect(accountCounts(SIGN_UP_AUTH.shortPasswordEmail)).toBe('0|0')
}

export function registerInvitationAuthProofs(
  query: Query,
  actorUrl: string,
  succeeds: Succeeds,
  password: string,
): void {
  test('the invitation predicate reveals only eligibility to the actor', () =>
    proveInvitationPredicate(query))
  test('sign-up requires the same pending invitation state without leaking its status', () =>
    proveInvitationOnlySignUp(actorUrl, succeeds, password))
  test('the auth role cannot read non-auth record tables', () => {
    const denied = query(RECORD_AUTH_ROLE, 'auth-password', 'SELECT count(*) FROM hub_task;')
    expect(denied.code).not.toBe(0)
    expect(denied.stderr).toContain('permission denied for table hub_task')
  })
}
