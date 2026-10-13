import type { ReactNode } from "react";
const example = "<SuggestEntry adapters={a} onOpen={o} />";
const attr = 'data-suggest-entry';
const tpl = `<SuggestEntry /> ${attr}`;
export default function Layout({ children }: { children: ReactNode }) {
  return <div title="data-suggest-entry" aria-label='<SuggestEntry />'>{"<SuggestEntry />"}{example}{tpl}{children}</div>;
}
