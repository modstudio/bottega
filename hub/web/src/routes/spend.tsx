import { createFileRoute } from '@tanstack/react-router'
import { InsightView } from '@/components/insight-view'

export const Route = createFileRoute('/spend')({ component: () => <InsightView name="spend" /> })
