import type { ReactNode } from "react";
import { Deep } from "@/components/deep1";
import { Shell } from "@/components/shell";
// Deep reaches the shell with no depth left; the direct import reaches it with room to spare.
export default function Layout({ children }: { children: ReactNode }) { return <div><Deep /><Shell>{children}</Shell></div>; }
