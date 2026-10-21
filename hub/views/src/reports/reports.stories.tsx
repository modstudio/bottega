import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { PLATFORM_NAME } from '../../../../shared/brand'
import { HostedReports } from './reports'

const measures = {
  hoursRunning: { unionMs: 3_600_000, sample: { intervalCount: 2 } },
  agentHours: { sumMs: 7_200_000, sample: { intervalCount: 3 } },
  sessionTime: {
    unionThenSumMs: 3_600_000,
    uncountedSilenceMs: 0,
    silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
    sample: { intervalCount: 2 },
  },
  cost: { vendorCostUsd: 4, vendorTokens: 100, sample: { intervalCount: 3 } },
  shipped: { count: 2, sample: { eventCount: 2 } },
}

const meta = {
  title: 'Views/Reports',
  component: HostedReports,
  args: {
    kind: 'space',
    onKindChange: fn(),
    projects: [{ name: PLATFORM_NAME }],
    people: [{ userId: 'person-1', name: 'Operator' }],
    project: PLATFORM_NAME,
    person: 'person-1',
    onProjectChange: fn(),
    onPersonChange: fn(),
    title: 'This space',
    measures,
    measuresError: null,
    sortedProjects: [{ name: PLATFORM_NAME }],
    projectMeasures: [{ data: measures }],
    projectPeople: [],
    personMeasures: [],
    windowControl: <button type="button">Last 7 days</button>,
  },
} satisfies Meta<typeof HostedReports>
export default meta
type Story = StoryObj<typeof meta>

export const Space: Story = {}
