import type { ReactNode } from "react";
import { Button } from "@/components/star";
export default function Layout({ children }: { children: ReactNode }) { return <div><Button />{children}</div>; }
