import { notFound } from '@tanstack/react-router'
import { isHostedMode } from '@/lib/hub-mode'

export function requireHostedSite() {
  if (!isHostedMode()) throw notFound()
}
