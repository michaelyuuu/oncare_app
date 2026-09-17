import type { ButtonHTMLAttributes, ReactNode } from "react";
export function BigButton({ children, tone = "primary", ...rest }: { children: ReactNode; tone?: "primary" | "secondary" | "danger" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`big-button big-button--${tone}`} {...rest}>{children}</button>;
}
