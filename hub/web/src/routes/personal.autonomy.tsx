import { createFileRoute } from '@tanstack/react-router'
import { PersonalAutonomyPage } from './-personal-autonomy'

export const Route = createFileRoute('/personal/autonomy')({ component: PersonalAutonomyPage })
