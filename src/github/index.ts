// "@supersuit/suggest-a-change/github": a suggestion becomes one ordinary GitHub issue. Zero runtime dependencies,
// web-standard fetch (injectable). Used straight from an app's server (createReportHandlers' `github` option) or by the
// owner's Mac with `gh`'s token.
export { privacyCatch, redact, mayFileAsIs, normalize } from './privacy.ts'
export type { Hit, HitKind, Person, CatchOptions } from './privacy.ts'
export { composeIssue, whatGoes, destinationWords, pieces, BODY_LIMIT } from './compose.ts'
export type { Piece, Destination, Draft, ComposeOptions, ComposedIssue } from './compose.ts'
export { fileIssue, updateIssue, addFollowUp, issueStates, issueStatus, fileSuggestion, attachPending, github, GitHubError } from './api.ts'
export type { GitHubConfig, FilingConfig, IssueState, FileSuggestionInput, FiledSuggestion, Fetch } from './api.ts'
export { branchHost, relayHost, toBase64, attachmentUrl, ATTACHMENTS_BRANCH, CONTENTS_API_BYTES } from './hosts.ts'
export type { AttachmentHost, AttachmentTarget, AttachmentFile } from './hosts.ts'
export { createSuggestionRelay, createAttachRelay, memoryUsage, RELAY_LIMITS, RELAY_VOICE_BYTES } from './relay.ts'
export type { SuggestionRelayOptions, AttachRelayOptions, RelayLimits, RelayUsage, RelayIdentity, Reservation, FiledRecord, StagingAdapter } from './relay.ts'
export { relayFiler, canFileDirectly, STAGE_OVER_BYTES } from './filer.ts'
export type { RelayFiler, RelayFiling, RelayFile, RelayCapabilities } from './filer.ts'
