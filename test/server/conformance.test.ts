import { test } from 'vitest'
import { runStoreConformance } from '../../src/server/index.ts'
import { makeMemoryStore } from './memory-store.ts'

await runStoreConformance(() => makeMemoryStore(), { test })
