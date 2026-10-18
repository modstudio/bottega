export type WindowInput = {
  hours: 24 | 48 | 168 | 720
  filters: { agent: string; project: string; source: string }
}
