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

  it('names the destination, and a public repo in the danger words', () => {
    expect(destinationWords(dest)).toEqual({ headline: 'Sending this files an issue on acme/app', privacy: "private: people with access to acme/app's code can read it", danger: false, account: "Filed from pat-gh's GitHub account." })
    expect(destinationWords({ ...dest, public: true })).toMatchObject({ privacy: 'public: anyone on the internet can read this', danger: true })
  })
})
