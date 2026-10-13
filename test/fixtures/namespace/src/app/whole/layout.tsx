import type { ReactNode } from "react";
import * as ui from "@/components/ui";
function Slot({ parts, children }: { parts: Record<string, unknown>; children: ReactNode }) { return <div data-n={Object.keys(parts).length}>{children}</div>; }
export default function Layout({ children }: { children: ReactNode }) { return <Slot parts={ui}>{children}</Slot>; }
