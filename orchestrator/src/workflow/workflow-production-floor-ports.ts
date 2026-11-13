// concern: workflow-floor-adapter
/** Assembles production floor ports at the CLI and MCP composition surfaces. */

import { type FloorEvidencePorts, productionFloorPorts } from './workflow-floor-evidence.ts'
import { productionReviewOwedFloor } from './workflow-review-owed-floor.ts'

export const productionWorkflowFloorPorts = (): FloorEvidencePorts => ({
  ...productionFloorPorts(),
  reviewOwed: productionReviewOwedFloor,
})
