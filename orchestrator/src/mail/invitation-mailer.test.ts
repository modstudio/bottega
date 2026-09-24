import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { sendRecordInvitationEmail } from './invitation-mailer.ts'

const environment = {
  SES_REGION: 'us-east-2',
  SES_FROM_ADDRESS: 'Sender <sender@example.test>',
  SES_ACCESS_KEY_ID: 'test-access-key',
  SES_SECRET_ACCESS_KEY: 'test-secret-key',
}

describe('record invitation mailer', () => {
  test('builds and sends the invitation details and link through the injected SES client', async () => {
    const commands: unknown[] = []
    await sendRecordInvitationEmail(
      {
        to: 'invitee@example.test',
        invitationUrl: 'https://hub.example.test/accept-invitation/invitation-one',
        spaceName: 'Workshop & Co',
        inviterName: 'Alex <Admin>',
        role: 'admin',
      },
      environment,
      { send: async (command) => commands.push(command.input) },
    )
    expect(commands).toEqual([
      {
        FromEmailAddress: environment.SES_FROM_ADDRESS,
        Destination: { ToAddresses: ['invitee@example.test'] },
        Content: {
          Simple: {
            Subject: {
              Data: `${PLATFORM_NAME} invitation to Workshop & Co`,
              Charset: 'UTF-8',
            },
            Body: {
              Text: {
                Data: [
                  'Alex <Admin> invited you to join Workshop & Co as admin.',
                  '',
                  'Accept the invitation: https://hub.example.test/accept-invitation/invitation-one',
                  '',
                  'This invitation lasts seven days.',
                ].join('\n'),
                Charset: 'UTF-8',
              },
              Html: {
                Data: '<p>Alex &lt;Admin&gt; invited you to join Workshop &amp; Co as admin.</p><p><a href="https://hub.example.test/accept-invitation/invitation-one">Accept the invitation</a></p><p>This invitation lasts seven days.</p>',
                Charset: 'UTF-8',
              },
            },
          },
        },
      },
    ])
  })

  test('refuses a real SES client under the test runner', async () => {
    await expect(
      sendRecordInvitationEmail(
        {
          to: 'invitee@example.test',
          invitationUrl: 'https://hub.example.test/accept-invitation/id',
          spaceName: 'Workshop',
          inviterName: 'Owner',
          role: 'member',
        },
        environment,
      ),
    ).rejects.toThrow('invitation mailer refuses a real SES client under the test runner')
  })
})
