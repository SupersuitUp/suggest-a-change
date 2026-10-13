'use client'
// THE RECEIPT. Three states, and "received" is the app's answer rather than the phone's hope: it is derived
// from the outbox, where a report's writes stay until the adapter has said `done` to each of them. While
// any is still there the report is only on the phone and the receipt says so.
import { useEffect, useState } from 'react'
import type { Adapters } from './adapters.ts'
import { belongsTo, useRuntime, useTick, type Runtime } from './runtime.ts'
import { receiptWords, stringsFor, type ReceiptState } from './words.ts'

export { receiptWords } from './words.ts'

export async function receiptState(rt: Runtime, adapters: Pick<Adapters, 'lands'>, reportId: string): Promise<{ state: ReceiptState; refused?: string }> {
  const mine = (await rt.outbox.pending()).filter((o) => belongsTo(o, reportId))
  const refused = mine.find((o) => o.error)?.error
  if (mine.length === 0) return { state: adapters.lands === 'mac' ? 'on-mac' : 'received' }
  return { state: 'on-phone', ...(refused ? { refused } : {}) }
}

export function Receipt({ adapters, reportId, onLine, quiet }: { adapters: Adapters; reportId: string; /** Told the line whenever it changes (a host's own live region). */ onLine?(line: string): void; /** The line is announced elsewhere, so this one is not a live region. */ quiet?: boolean }) {
  const { rt } = useRuntime(adapters)
  const tick = useTick(rt)
  const S = stringsFor(adapters.words)
  const [now, setNow] = useState<{ state: ReceiptState; refused?: string }>({ state: 'on-phone' })
  useEffect(() => {
    if (!rt) return
    let live = true
    void receiptState(rt, adapters, reportId).then((s) => { if (live) setNow(s) })
    return () => { live = false }
  }, [rt, tick, reportId, adapters.lands])
  const line = receiptWords(now.state, adapters.words)
  useEffect(() => { onLine?.(line) }, [line])
  return (
    <div className="sac-receipt" data-receipt={now.state} tabIndex={-1}>
      <p {...(quiet ? {} : { role: 'status' })} className="sac-receipt-line">{line}</p>
      {now.refused ? <p role="alert" className="sac-error">{now.refused}</p> : null}
      {now.refused && rt ? <button type="button" className="sac-button" onClick={() => void rt.retry(reportId)}>{S.retry}</button> : null}
    </div>
  )
}
