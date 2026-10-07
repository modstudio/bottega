import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HostedPublicFrame,
  HostedSignInFrame,
  identityQueryEnabled,
  RailFooterIdentity,
} from '@/routes/__root'
import { spaceMenuItems } from '@/ui/shell/user-menu'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

test('the public origin never enables the root identity query', () => {
  expect(identityQueryEnabled(true, '/', 'public')).toBe(false)
  expect(identityQueryEnabled(true, '/docs', 'public')).toBe(false)
  expect(identityQueryEnabled(true, '/product/board', 'public')).toBe(false)
  expect(identityQueryEnabled(true, '/', 'app')).toBe(true)
  expect(identityQueryEnabled(true, '/', 'unconfigured')).toBe(true)
})

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

test('hosted public frame is rail-free and full width', () => {
  const html = renderToStaticMarkup(
    <HostedPublicFrame>
      <p>Docs page</p>
    </HostedPublicFrame>,
  )
  expect(html).toContain('Docs page')
  expect(html).not.toContain('aria-label="Navigation"')
  expect(html).not.toContain('max-w-md')
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

test('hosted rail names its only active space without offering a switcher', () => {
  const html = renderToStaticMarkup(
    <RailFooterIdentity
      hosted
      email="reader@example.test"
      activeSpaceId="space-a"
      spaces={[{ id: 'space-a', name: 'Space A' }]}
      onSelectSpace={() => {}}
      onSignOut={() => {}}
    />,
  )

  expect(html).toContain('Space A')
  expect(html).not.toContain('Space A ✓')
})

test('hosted rail offers all memberships and choosing one sets the active space', () => {
  let selected = ''
  const spaces = [
    { id: 'space-a', name: 'Space A' },
    { id: 'space-b', name: 'Space B' },
  ]
  const html = renderToStaticMarkup(
    <RailFooterIdentity
      hosted
      email="reader@example.test"
      activeSpaceId="space-a"
      spaces={spaces}
      onSelectSpace={(spaceId) => {
        selected = spaceId
      }}
      onSignOut={() => {}}
    />,
  )

  expect(html).toContain('Space A ✓')
  expect(html).toContain('Space B')
  spaceMenuItems(spaces, 'space-a', (spaceId) => {
    selected = spaceId
  })
    .find((item) => item.label === 'Space B')
    ?.onSelect()
  expect(selected).toBe('space-b')
})

test('local identity is unchanged', () => {
  const html = renderToStaticMarkup(
    <RailFooterIdentity hosted={false} email={null} onSignOut={() => {}} />,
  )

  expect(html).toContain('Local')
  expect(html).toContain('This machine')
  expect(html).not.toContain('Sign out</button>')
})
