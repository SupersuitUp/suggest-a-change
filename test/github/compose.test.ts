// ONE PLAIN ISSUE (design section 2), and the sheet's list of what goes (section 1). The two are built from one
// list of pieces, and the parity test below holds them to each other: nothing goes that is not on the list.
import { describe, expect, it } from 'vitest'
import { BODY_LIMIT, composeIssue, destinationWords, whatGoes } from '../../src/github/index.ts'

const ID = 'r-20261026170412-ab12cd'
const full = () => ({
  id: ID,
  kind: 'change',
  words: 'The home tile should show the next meeting. It is hidden now.',
  who: { member: 'mk_7Hq2xP9vL3sT8wK1', role: 'operator' },
  voice: [{ file: 'voice-1.m4a', ms: 20_000 }],
  media: [
    { file: 'image-1.png', type: 'image/png', bytes: 1000 },
    { file: 'image-2.jpg', type: 'image/jpeg', bytes: 2000 },
    { file: 'video-3.mp4', type: 'video/mp4', bytes: 9000, ms: 12_000 },
  ],
  where: { screen: 'Home', route: '/' },
  diagnostics: { appVersion: '2.14.0', at: '2026-10-26T17:04:12Z', device: 'iPhone', screen: '390x844' },
  filerName: 'Pat Okafor',
  appName: 'Helm',
})
const urls = {
  'image-1.png': 'https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/image-1.png?raw=true',
  'image-2.jpg': 'https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/image-2.jpg?raw=true',
  'video-3.mp4': 'https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/video-3.mp4?raw=true',
  'voice-1.m4a': 'https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/voice-1.m4a?raw=true',
}
const opts = { appName: 'Helm', appVersion: '2.14.0', filerName: 'Pat Okafor', filerRole: 'operator', attachmentUrls: urls, transcript: 'I want to see the next meeting on the home tile.' }
const dest = { repo: 'acme/app', public: false, account: 'pat-gh', attaches: true }

describe('composeIssue', () => {
  it('writes the design\'s body, section by section', () => {
    const { title, body, labels } = composeIssue(full(), opts)
    expect(title).toBe('The home tile should show the next meeting.')
    expect(labels).toEqual(['enhancement', 'app:helm'])
    const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    expect(sections).toEqual(['What they said', "Voice note (transcribed on the owner's Mac)", 'Screenshots', 'Where', 'About', 'Filed by'])
    expect(body).toContain(`![image-1.png](${urls['image-1.png']})`)
    expect(body).toContain(`![image-2.jpg](${urls['image-2.jpg']})`)
    expect(body).toContain(`[video-3.mp4](${urls['video-3.mp4']})`)
    expect(body).not.toContain(`![video-3.mp4]`) // a video is linked, never inline
    expect(body).toContain(`[voice-1.m4a](${urls['voice-1.m4a']})`)
    expect(body).toContain('Screen: Home · Route: /')
    expect(body).toContain('App: Helm 2.14.0 · Device: iPhone · Screen 390x844 · Sent 2026-10-26 17:04 UTC')
    expect(body).toContain(`Pat Okafor (operator), through Suggest a change in the Helm. Report ${ID}.`)
  })

  it('labels the kind with GitHub\'s own names and the app as app:<slug>', () => {
    expect(composeIssue({ ...full(), kind: 'broken' }, { ...opts, appName: 'First Years' }).labels).toEqual(['bug', 'app:first-years'])
    expect(composeIssue({ ...full(), kind: 'feedback' }, opts).labels).toEqual(['feedback', 'app:helm'])
  })

  it('titles from the first sentence of the words, else the transcript, at most 70 characters, else the app', () => {
    expect(composeIssue({ ...full(), words: '' }, opts).title).toBe('I want to see the next meeting on the home tile.')
    const long = composeIssue({ ...full(), words: 'word '.repeat(40) }, opts).title
    expect(long.length).toBeLessThanOrEqual(70)
    expect(long.endsWith('…')).toBe(true)
    expect(composeIssue({ ...full(), words: '', voice: [] }, { ...opts, transcript: undefined }).title).toBe('Suggestion from Helm')
    expect(composeIssue({ ...full(), words: 'first line\nsecond line' }, opts).title).toBe('first line')
  })

  it('never carries the member key or an email, whatever the words say', () => {
    const r = { ...full(), words: 'my key mk_7Hq2xP9vL3sT8wK1 and mail me at amy@example.com' }
    const { body, title } = composeIssue(r, opts)
    expect(body + title).not.toContain('mk_7Hq2xP9vL3sT8wK1')
    expect(body + title).not.toMatch(/@example\.com/)
  })

  it('stays under GitHub\'s body limit, cutting the transcript with a note', () => {
    const { body } = composeIssue(full(), { ...opts, transcript: 'talk '.repeat(20_000) })
    expect(body.length).toBeLessThan(65_536)
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(body).toMatch(/transcript was cut/i)
    expect(body).toContain(`Report ${ID}.`) // the end of the body survives the cut
  })

  it('in pending mode, says what is being added instead of linking it, and keeps the report id exact', () => {
    const { body } = composeIssue(full(), { ...opts, pending: true })
    expect(body).not.toContain('blob/suggestion-attachments')
    expect(body).toMatch(/2 screenshots, 1 video and 1 voice recording are being added/)
    expect(body).toContain(`Report ${ID}.`)
    // a file still missing after the edit keeps saying it is coming
    const partial = composeIssue(full(), { ...opts, attachmentUrls: { 'image-1.png': urls['image-1.png'] } })
    expect(partial.body).toContain(`![image-1.png](${urls['image-1.png']})`)
    expect(partial.body).toMatch(/1 screenshot, 1 video and 1 voice recording are being added/)
  })
})

describe('whatGoes: the sheet and the issue cannot drift', () => {
  it('lists, in order, exactly the pieces the composed issue carries, and each piece is in the body', () => {
    const items = whatGoes(full(), dest)
    const composed = composeIssue(full(), opts)
    expect(items.map((i) => i.key)).toEqual(composed.carries)
    expect(items.map((i) => i.key)).toEqual(['words', 'voice', 'images', 'video', 'where', 'app', 'device', 'time', 'filer'])
    expect(items.map((i) => i.text)).toEqual([
      'your words',
      'your voice note and its transcript',
      '2 screenshots, saved to the suggestion-attachments branch of acme/app',
      '1 video, saved to the suggestion-attachments branch of acme/app',
      'this screen (Home, /)',
      'Helm 2.14.0',
      'iPhone, 390x844',
      'the time',
      'your name, Pat Okafor',
    ])
    // and every listed item's content really is in the body
    const shown: Record<string, string[]> = {
      words: ['The home tile should show the next meeting. It is hidden now.'],
      voice: [opts.transcript, urls['voice-1.m4a']],
      images: [urls['image-1.png'], urls['image-2.jpg']],
      video: [urls['video-3.mp4']],
      where: ['Home', 'Route: /'],
      app: ['Helm 2.14.0'],
      device: ['iPhone', '390x844'],
      time: ['2026-10-26 17:04 UTC'],
      filer: ['Pat Okafor'],
    }
    for (const it of items) for (const s of shown[it.key]) expect(composed.body, it.key).toContain(s)
  })

  it('a draft with less carries less, on both sides', () => {
    const bare = { id: ID, kind: 'feedback', words: 'nice', who: { member: 'x', role: 'member' }, where: { screen: 'Home', route: '/' }, diagnostics: {} }
    const items = whatGoes(bare, dest)
    expect(items.map((i) => i.key)).toEqual(composeIssue(bare, { appName: 'Helm' }).carries)
    expect(items.map((i) => i.key)).toEqual(['words', 'where', 'filer'])
    expect(composeIssue(bare, { appName: 'Helm' }).body).not.toMatch(/## (Voice note|Screenshots|About)/)
  })

  it('when the repo cannot take files yet, the list says they wait; a voice note with no transcription says so', () => {
    const items = whatGoes(full(), { ...dest, attaches: false, transcribes: false })
    expect(items.find((i) => i.key === 'images')!.text).toBe('2 screenshots, added once acme/app can take attachments')
    expect(items.find((i) => i.key === 'voice')!.text).toBe('your voice note')
  })

  it('says in advance when a file is larger than the destination can take, and that it will not reach the issue', () => {
    const items = whatGoes({ ...full(), media: [{ file: 'image-1.png', type: 'image/png', bytes: 1000 }, { file: 'video-3.mp4', type: 'video/mp4', bytes: 9 * 2 ** 20 }] }, { ...dest, maxInlineBytes: 4 * 2 ** 20 })
    expect(items.find((i) => i.key === 'video')!.text).toBe('1 video, saved to the suggestion-attachments branch of acme/app; video-3.mp4 is over the 4 MB acme/app can take, so it does not reach the issue')
    expect(items.find((i) => i.key === 'images')!.text).toBe('1 screenshot, saved to the suggestion-attachments branch of acme/app')
  })

  it('takes the app label from the host when given one, and none when told there is none', () => {
    expect(composeIssue(full(), { ...opts, appLabel: 'helm-ios' }).labels).toEqual(['enhancement', 'app:helm-ios'])
    expect(composeIssue(full(), { ...opts, appLabel: null }).labels).toEqual(['enhancement'])
    expect(composeIssue({ ...full(), appName: undefined }, { ...opts, appName: undefined }).body).toContain('through Suggest a change in an app.')
  })

  it('names the destination, and a public repo in the danger words', () => {
    expect(destinationWords(dest)).toEqual({ headline: 'Sending this files an issue on acme/app', privacy: "private: people with access to acme/app's code can read it", danger: false, account: "Filed from pat-gh's GitHub account." })
    expect(destinationWords({ ...dest, public: true })).toMatchObject({ privacy: 'public: anyone on the internet can read this', danger: true })
  })

  it('a filing through a relay says the app opens it and names the sender, never a GitHub account that is not theirs', () => {
    expect(destinationWords({ ...dest, via: 'relay', relayApp: 'Supersuit Suggestions', name: 'Pat Lee' }).account)
      .toBe('Opened by the Supersuit Suggestions app on GitHub, which says it came from Pat Lee.')
    expect(destinationWords({ ...dest, via: 'relay' }).account).toBe('Opened by a suggestions app on GitHub, which says it came from you.')
    expect(destinationWords({ ...dest, via: 'direct', name: 'Pat Lee' }).account).toBe("Filed from pat-gh's GitHub account.")
  })
})

describe('the context, shared so it can be fixed, and a way to reach them', () => {
  const ctx = () => ({
    items: [
      { key: 'time', label: 'Your local time', value: '2026-10-26 12:04 (America/Chicago, UTC-05:00)', why: 'so the fixer can line it up with the logs from that moment' },
      { key: 'device', label: 'Your device', value: 'iPhone, iOS 18.1, Safari 18.1', why: 'so the fixer can try it on the same kind of phone' },
      { key: 'app:0', label: 'Plan | tier', value: 'Pro <b>yearly</b>', why: 'some features only exist on Pro' },
    ],
    routes: [{ route: '/home', at: '2026-10-26T17:03:00Z' }, { route: '/notes', at: '2026-10-26T17:04:00Z' }],
    taps: [{ label: 'New note', at: '2026-10-26T17:04:01Z' }, { label: 'Save note', at: '2026-10-26T17:04:05Z' }],
    errors: [{ message: 'TypeError: save is not a function', frame: 'at click (https://app.test/app.js:10:4)', at: '2026-10-26T17:04:05Z' }],
  })
  const withCtx = (over: Record<string, unknown> = {}) => ({ ...full(), context: ctx(), who: { member: 'x', role: 'member', contact: { email: 'pat@example.com', phone: '+1 917 555 0100', handle: '@pat' } }, ...over })

  it('writes the context as a table of what, value and why, with the trail in collapsible blocks, instead of About', () => {
    const { body } = composeIssue(withCtx(), opts)
    expect(body).toContain('## Context (shared so this can be fixed)')
    expect(body).toContain('| What | Value | Why |')
    expect(body).toMatch(/\| App \| Helm 2\.14\.0 \| .+ \|/)
    expect(body).toContain('| Your device | iPhone, iOS 18.1, Safari 18.1 | so the fixer can try it on the same kind of phone |')
    expect(body).toContain('| Plan \\| tier | Pro &lt;b&gt;yearly&lt;/b&gt; | some features only exist on Pro |') // a cell cannot break the table or inject markup
    expect(body).not.toContain('## About')
    expect(body).toContain('<details><summary>Pages visited before this (2)</summary>')
    expect(body).toContain('<details><summary>Last taps (2)</summary>')
    expect(body).toContain('<details><summary>Errors on the page (1)</summary>')
    expect(body).toContain('TypeError: save is not a function')
    expect(body.indexOf('## Context')).toBeLessThan(body.indexOf('## Filed by'))
  })

  it('says how to reach them, as links, to thank them or ask a question', () => {
    const { body } = composeIssue(withCtx(), opts)
    expect(body).toContain('## Reach them')
    expect(body).toContain('To thank them or ask a follow-up question:')
    expect(body).toContain('[pat@example.com](mailto:pat@example.com)')
    expect(body).toContain('[+1 917 555 0100](tel:+19175550100)')
    expect(body).toContain('@‍pat') // a handle never pings anyone on GitHub
    expect(composeIssue(withCtx({ who: { member: 'x', role: 'member' } }), opts).body).not.toContain('## Reach them')
  })

  it('the sheet lists exactly what the body carries, with each value and why; leaving one out leaves it out of both', () => {
    const items = whatGoes(withCtx(), dest)
    const composed = composeIssue(withCtx(), opts)
    expect(items.map((i) => i.key)).toEqual(composed.carries)
    expect(items.map((i) => i.key)).toEqual(['words', 'voice', 'images', 'video', 'where', 'app', 'ctx:time', 'ctx:device', 'ctx:app:0', 'routes', 'taps', 'errors', 'contact', 'filer'])
    const device = items.find((i) => i.key === 'ctx:device')!
    expect(device).toMatchObject({ text: 'Your device', value: 'iPhone, iOS 18.1, Safari 18.1', why: 'so the fixer can try it on the same kind of phone', optional: true, on: true })
    for (const fixed of ['words', 'voice', 'images', 'video', 'app', 'filer']) expect(items.find((i) => i.key === fixed)!.optional, fixed).toBeFalsy()
    for (const it of items.filter((i) => i.key.startsWith('ctx:') || i.key === 'contact')) expect(composed.body, it.key).toContain(it.value!.split(' · ')[0].replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    // leave the device and the taps out
    const less = withCtx({ context: { ...ctx(), items: ctx().items.filter((i) => i.key !== 'device'), taps: [] } })
    const fewer = whatGoes(less, dest)
    expect(fewer.map((i) => i.key)).toEqual(composeIssue(less, opts).carries)
    expect(fewer.map((i) => i.key)).not.toContain('ctx:device')
    expect(fewer.map((i) => i.key)).not.toContain('taps')
    expect(composeIssue(less, opts).body).not.toMatch(/iPhone, iOS|Last taps/)
  })

  it('the way to reach them is on for a private repo and off, with the reason, for a public one', () => {
    expect(whatGoes(withCtx(), dest).find((i) => i.key === 'contact')).toMatchObject({ optional: true, on: true, value: 'pat@example.com · +1 917 555 0100 · @pat' })
    expect(whatGoes(withCtx(), { ...dest, public: true }).find((i) => i.key === 'contact')).toMatchObject({ optional: true, on: false, reason: 'this repo is public, so anyone could read it' })
  })

  it('neutralizes markdown in every report-borne string: no mentions, references, images or raw HTML', () => {
    const evil = '@everyone #12 ![x](https://evil.example/x.png) <img src=x onerror=alert(1)> **bold** [link](https://evil.example)'
    const r = withCtx({
      words: 'look ```` here\n' + evil,
      where: { screen: evil, route: '/notes' },
      context: { ...ctx(), items: [{ key: 'app:0', label: evil, value: evil, why: evil }], taps: [{ label: evil, at: 'x' }], errors: [{ message: evil, frame: evil, at: 'x' }] },
      who: { member: 'x', role: 'member', contact: { email: 'pat@example.com', handle: '[me](javascript:alert(1)) @pat' } },
    })
    const { body } = composeIssue(r, { ...opts, filerName: '@everyone ![a](https://evil.example/a.png)', transcript: '```\n' + evil + '\n```' })
    // the words and the transcript sit in fences longer than any backtick run inside them
    expect(body).toContain('`````\nlook ```` here\n@everyone')
    // outside the fences: no live mention, reference, image, link or tag
    const outside = body.replace(/(`{3,})[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g, '')
    // (an escaped bracket, `\]`, is inert: only an unescaped `](` makes a link)
    expect(outside).not.toMatch(/@everyone|#12|!\[x\]\(|<img|\[link\]\(https:\/\/evil|(^|[^\\])\]\(javascript:/)
    expect(outside).not.toMatch(/(^|\s)@pat/)
    // the only images are the attachments the host produced
    expect([...outside.matchAll(/(?<!\\)!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])).toEqual([urls['image-1.png'], urls['image-2.jpg']])
  })

  it('a time that is not a time is escaped like any other line, and forges no section', () => {
    const forged = 'x\n## Reach them\n@everyone'
    const about = composeIssue({ ...full(), diagnostics: { ...full().diagnostics, at: forged } }, opts).body
    const trail = composeIssue(withCtx({ who: { member: 'x', role: 'member' }, context: { ...ctx(), routes: [{ route: '/a', at: forged }], taps: [{ label: 'a', at: forged }] } }), opts).body
    for (const body of [about, trail]) {
      expect(body).not.toMatch(/^## Reach them$/m)
      expect(body).not.toContain('@everyone')
    }
  })

  it('stays under the body limit by cutting the trail first, before the transcript', () => {
    const huge = withCtx({ context: { ...ctx(), taps: Array.from({ length: 3000 }, (_, i) => ({ label: `tap ${i} ${'x'.repeat(60)}`, at: '2026-10-26T17:04:01Z' })), errors: Array.from({ length: 400 }, () => ({ message: 'e'.repeat(300), at: 'x' })) } })
    const { body } = composeIssue(huge, opts)
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(body).toContain(opts.transcript) // the transcript survives whole
    expect(body).toMatch(/cut to fit/)
    expect(body).toContain(`Report ${ID}.`)
  })
})
