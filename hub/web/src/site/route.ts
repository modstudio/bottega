import { notFound } from '@tanstack/react-router'
import { isHostedMode } from '@/lib/hub-mode'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'

const SITE_DESCRIPTION = `You keep every decision. Workers do the rest. ${PLATFORM_NAME} runs the whole task lifecycle for coding agents: declared workflows, multi-lens review on a budget, a board across every project.`
export const siteHead = () => ({
  meta: [{ title: PLATFORM_NAME }, { name: 'description', content: SITE_DESCRIPTION }],
})

export function requireHostedSite() {
  if (!isHostedMode()) throw notFound()
}
