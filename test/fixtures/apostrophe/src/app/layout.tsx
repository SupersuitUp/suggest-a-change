import type { ReactNode } from "react";
import { SuggestEntry } from "@supersuit/suggest-a-change/client";
export default function Layout({ children }: { children: ReactNode }) {
  return <div><p>Don't {/* a comment with a ' in it */}<SuggestEntry adapters={{} as never} onOpen={() => {}} /></p>{children}</div>;
}
