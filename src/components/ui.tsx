import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonProps) {
  return <button className={`ui-button ui-button-${variant} ${className}`.trim()} {...props} />;
}

export function Card({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card ${className}`.trim()} {...props}>{children}</div>;
}

export function Badge({ className = "", children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`ui-badge ${className}`.trim()} {...props}>{children}</span>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="ui-loading" role="status"><span className="ui-spinner" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="ui-empty" role="status"><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}
