import { createFileRoute } from '@tanstack/react-router'
import { HostedReports } from '@/components/hosted-reports'

export const Route = createFileRoute('/reports')({ component: HostedReports })
