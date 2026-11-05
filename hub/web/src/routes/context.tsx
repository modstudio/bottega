import { createFileRoute, redirect } from '@tanstack/react-router'

/** The former Agent settings address opens Personal settings. */
export const Route = createFileRoute('/context')({
  beforeLoad: () => {
    throw redirect({ to: '/personal/instructions' })
  },
})
