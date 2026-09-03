import { chmodSync } from 'node:fs'

const fixture = new URL('./project-register.ts', import.meta.url).pathname
chmodSync(fixture, 0o755)
process.env.HUB_ORCH = fixture
