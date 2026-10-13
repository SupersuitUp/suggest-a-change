import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
const Wrapper = Shell;
export default function Layout({ children }: { children: ReactNode }) { return <Wrapper>{children}</Wrapper>; }
