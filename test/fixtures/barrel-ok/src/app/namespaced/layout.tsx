import type { ReactNode } from "react";
import * as ui from "@/components/via-star";
export default function Layout({ children }: { children: ReactNode }) { return <ui.Shell>{children}</ui.Shell>; }
