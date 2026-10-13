import type { ReactNode, ComponentType } from "react";
import { Shell } from "@/components/shell";
function Providers({ Layout, children }: { Layout: ComponentType<{ children: ReactNode }>; children: ReactNode }) { return <Layout>{children}</Layout>; }
export default function Layout({ children }: { children: ReactNode }) { return <Providers Layout={Shell}>{children}</Providers>; }
