import type { Meta, StoryObj } from '@storybook/react-vite'
import { MeasuresSummary } from './measures-summary'

const measures = {
  hoursRunning: { unionMs: 3_600_000 },
  agentHours: { sumMs: 7_200_000, unknownShare: { sumMs: 5_400_000 } },
  sessionTime: {
    unionThenSumMs: 3_600_000,
    uncountedSilenceMs: 900_000,
    silenceAllowanceSentence: 'Silences longer than ten minutes are not counted.',
    unknownUser: { unionThenSumMs: 7_200_000, uncountedSilenceMs: 1_800_000 },
  },
  cost: {
    vendorCostUsd: 4,
    vendorTokens: 100,
    unknownShare: { vendorCostUsd: 3, vendorTokens: 75 },
  },
  shipped: { count: 2 },
  cycleTime: { medianMs: 3_600_000, n: 2 },
}

const meta = {
  title: 'Views/Measures/MeasuresSummary',
  component: MeasuresSummary,
  args: { measures },
} satisfies Meta<typeof MeasuresSummary>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { globals: { theme: 'dark' } }
