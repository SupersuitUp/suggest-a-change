import type { ReactNode } from "react";
import { SuggestEntry } from "@supersuit/suggest-a-change/client";
// TODO: render <SuggestEntry adapters={a} onOpen={o} /> here once the adapters exist (data-suggest-entry)
export default function Layout({ children }: { children: ReactNode }) { return <div>{children}{String(SuggestEntry)}</div>; }
