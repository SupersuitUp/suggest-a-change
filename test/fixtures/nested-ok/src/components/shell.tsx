import type { ReactNode } from "react";
import { Entry } from "./entry";
export function Shell({ children }: { children: ReactNode }) { return <section><Entry />{children}</section>; }
