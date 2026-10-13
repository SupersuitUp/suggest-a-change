import type { ReactNode } from "react";
import { SuggestEntry } from "@supersuit/suggest-a-change/client";
export default function Layout({ children }: { children: ReactNode }) { return <><SuggestEntry adapters={{} as never} onOpen={() => {}} />{children}</>; }
