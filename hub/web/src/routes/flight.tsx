import { createFileRoute } from '@tanstack/react-router'
import { Flight } from './-flight'

export const Route = createFileRoute('/flight')({
  component: Flight,
})
