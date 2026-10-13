import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
// Imports the shell and never renders it.
export default function Layout({ children }: { children: ReactNode }) { return <div data-shell={String(Shell)}>{children}</div>; }
