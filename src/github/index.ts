// "@supersuit/suggest-a-change/github": a suggestion becomes one ordinary GitHub issue. Zero runtime dependencies,
// web-standard fetch (injectable). Used straight from an app's server (createReportHandlers' `github` option) or by the
// owner's Mac with `gh`'s token.
export { privacyCatch, redact, mayFileAsIs } from './privacy.ts'
export type { Hit, HitKind, Person, CatchOptions } from './privacy.ts'
export { composeIssue, whatGoes, destinationWords, pieces, BODY_LIMIT } from './compose.ts'
export type { Piece, Destination, Draft, ComposeOptions, ComposedIssue } from './compose.ts'
export { fileIssue, updateIssue, addFollowUp, issueStates, issueStatus, fileSuggestion, attachPending, github, GitHubError } from './api.ts'
export type { GitHubConfig, IssueState, FileSuggestionInput, FiledSuggestion, Fetch } from './api.ts'
export { branchHost, relayHost, toBase64, attachmentUrl, ATTACHMENTS_BRANCH } from './hosts.ts'
export type { AttachmentHost, AttachmentTarget, AttachmentFile } from './hosts.ts'
export { createAttachRelay, memoryUsage, RELAY_LIMITS, RELAY_VOICE_BYTES } from './relay.ts'
export type { AttachRelayOptions, RelayLimits, RelayUsage } from './relay.ts'
