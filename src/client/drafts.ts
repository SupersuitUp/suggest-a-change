// A DRAFT BELONGS TO ONE APP AND ONE ACCOUNT. Two people can use one phone (a shared tablet, a signed-out
// and signed-in again), and a draft is the most private thing the button holds: half a thought, maybe a
// complaint about the person who is about to pick the phone up. So the key names both, and switching
// people can never show the other's draft. The report id is made the moment the draft starts and stays
// with it, so a send that is repeated (a double tap, a retry after a lost reply) is the same report.
import { newReportId } from '../contract.mjs'
import type { Store } from './idb.ts'

export interface Draft {
  /** Made when the draft starts; it is the dedupe key everywhere the report travels. */
  reportId: string
  kind?: string
  words: string
  /** Keys of attachments held in the `blobs` store (voice takes, images, one video). */
  attachments: string[]
  updatedAt: number
  /** Set when the draft's report has been put in the outbox. The next save then starts a new draft. */
  queued?: boolean
}

/** `app` may not contain ':' (the account may), so two different pairs can never make the same key. */
export function draftKey({ app, account }: { app: string; account: string }): string {
  if (app.includes(':')) throw new Error(`an app name cannot contain ":" (got ${JSON.stringify(app)})`)
  return `sac:${app}:${account}`
}

export async function loadDraft(store: Store, key: string): Promise<Draft | undefined> {
  return store.get<Draft>('kv', key)
}

/** Saves what the person has so far. The first save of a draft makes its report id; later saves keep it,
 *  until the report is queued: a save after that starts a new draft with a new id, so words typed while
 *  the old report is still sending are never part of it and never lost when it lands. */
export async function saveDraft(
  store: Store,
  key: string,
  fields: Partial<Pick<Draft, 'kind' | 'words' | 'attachments'>> = {},
  { now = () => Date.now(), makeId = () => newReportId() }: { now?: () => number; makeId?: () => string } = {},
): Promise<Draft> {
  const queuedBefore = await loadDraft(store, key)
  const had = queuedBefore?.queued ? undefined : queuedBefore
  const draft: Draft = {
    reportId: had?.reportId ?? makeId(),
    words: '',
    attachments: [],
    ...had,
    ...fields,
    updatedAt: now(),
  }
  await store.put('kv', key, draft)
  return draft
}

/** Clears the draft. With `reportId`, only if the draft still belongs to that report. */
export async function clearDraft(store: Store, key: string, reportId?: string): Promise<void> {
  if (reportId !== undefined && (await loadDraft(store, key))?.reportId !== reportId) return
  await store.del('kv', key)
}
