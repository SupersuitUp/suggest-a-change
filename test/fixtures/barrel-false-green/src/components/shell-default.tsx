import type { ReactNode } from "react";
import { Entry } from "./entry";
export default function Shell({ children }: { children: ReactNode }) { return <section><Entry />{children}</section>; }
