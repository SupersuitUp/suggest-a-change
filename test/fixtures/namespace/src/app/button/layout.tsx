import type { ReactNode } from "react";
import * as ui from "@/components/ui";
export default function Layout({ children }: { children: ReactNode }) { return <div><ui.Button />{children}</div>; }
