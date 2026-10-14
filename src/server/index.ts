// "@supersuit/suggest-a-change/server": web-standard APIs only, no runtime dependency, nothing from react or the client.
export { createReportHandlers, reportRevision, VOICE_BYTES_PER_SECOND, LEASE_MS, BODY_CAP, APPROVAL_LEASE_MS, HELD_MS, READ_TTL_MS, INCOMPLETE_GRACE_MS, VOICE_FILE_BYTES } from './handlers.ts'
export type { HostedStore, StoredReport, TimelineEntry, FileState, FollowUp, TellEvent, ReportHandlerOptions } from './handlers.ts'
export { sniffType, sameType, canonicalType, ACCEPTED_TYPES } from './sniff.ts'
export { effectiveLimits } from './rate.ts'
export type { Limits } from './rate.ts'
export { runStoreConformance, checks as conformanceChecks } from './conformance.ts'
export type { StoreHarness, MakeStore, ConformanceTest } from './conformance.ts'
