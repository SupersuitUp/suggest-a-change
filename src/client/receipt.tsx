// THE RECEIPT. Three states, and "received" is the app's answer rather than the phone's hope: it needs the
// adapter to have said `done` to the report AND no write of that report left in the outbox. Until then
// the report is only on the phone and the receipt says so.
import { useEffect, useState } from 'react'
import type { Adapters } from './adapters.ts'
import { belongsTo, useRuntime, useTick, type Runtime } from './runtime.ts'
import { receiptWords, stringsFor, type ReceiptState } from './words.ts'

export { receiptWords } from './words.ts'

export async function receiptState(rt: Runtime, adapters: Pick<Adapters, 'lands'>, reportId: string): Promise<{ state: ReceiptState; refused?: string }> {
  const mine = (await rt.outbox.pending()).filter((o) => belongsTo(o, reportId))
  const refused = mine.find((o) => o.error)?.error
  if (rt.acked(reportId) && mine.length === 0) return { state: adapters.lands === 'mac' ? 'on-mac' : 'received' }
  return { state: 'on-phone', ...(refused ? { refused } : {}) }
}

export function Receipt({ adapters, reportId }: { adapters: Adapters; reportId: string }) {
  const rt = useRuntime(adapters)
  const tick = useTick(rt)
  const [now, setNow] = useState<{ state: ReceiptState; refused?: string }>({ state: 'on-phone' })
  useEffect(() => {
    if (!rt) return
    let live = true
    void receiptState(rt, adapters, reportId).then((s) => { if (live) setNow(s) })
    return () => { live = false }
  }, [rt, tick, reportId, adapters])
  return (
    <div className="sac-receipt" data-receipt={now.state}>
      <p role="status" className="sac-receipt-line">{receiptWords(now.state, adapters.words)}</p>
      {now.refused ? (
        <p role="alert" className="sac-error">{now.refused}</p>
      ) : null}
      {now.refused && rt ? (
        <button type="button" className="sac-button" onClick={() => void rt.retry(reportId)}>{stringsFor(adapters.words).retry}</button>
      ) : null}
    </div>
  )
}
