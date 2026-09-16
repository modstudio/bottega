export const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()
