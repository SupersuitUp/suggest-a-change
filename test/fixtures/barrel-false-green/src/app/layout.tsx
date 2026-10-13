import type { ReactNode } from "react";
import { Button } from "@/components";
export default function Layout({ children }: { children: ReactNode }) { return <div><Button />{children}</div>; }
