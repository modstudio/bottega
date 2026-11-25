export const trackerLegSource = (project: string) => `tasks:${project}`

export const isTrackerLegSource = (source: string) => source.startsWith('tasks:')
