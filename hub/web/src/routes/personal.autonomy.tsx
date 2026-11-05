import { createFileRoute } from '@tanstack/react-router'
import { PersonalAutonomyPage } from './-personal-settings'

export const Route = createFileRoute('/personal/autonomy')({ component: PersonalAutonomyPage })
