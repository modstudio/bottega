import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostedSignInFrame, RailFooterIdentity } from '@/routes/__root'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

test('hosted sign-in renders without application navigation or a rail footer', () => {
  const html = renderToStaticMarkup(
    <HostedSignInFrame>
      <form aria-label="Sign in">Sign in form</form>
    </HostedSignInFrame>,
  )

  expect(html).toContain(PLATFORM_NAME)
  expect(html).toContain('Sign in form')
  expect(html).not.toContain('aria-label="Navigation"')
  expect(html).not.toContain('Hosted hub')
})

test('hosted identity without a session is signed out and cannot sign out', () => {
  const html = renderToStaticMarkup(<RailFooterIdentity hosted email={null} onSignOut={() => {}} />)

  expect(html).toContain('Signed out')
  expect(html).toContain('Hosted hub')
  expect(html).not.toContain('Sign out</button>')
})

test('hosted identity with a session renders its email and can sign out', () => {
  const html = renderToStaticMarkup(
    <RailFooterIdentity hosted email="reader@example.test" onSignOut={() => {}} />,
  )

  expect(html).toContain('reader@example.test')
  expect(html).toContain('Sign out</button>')
})

test('local identity is unchanged', () => {
  const html = renderToStaticMarkup(
    <RailFooterIdentity hosted={false} email={null} onSignOut={() => {}} />,
  )

  expect(html).toContain('Local')
  expect(html).toContain('This machine')
  expect(html).not.toContain('Sign out</button>')
})
