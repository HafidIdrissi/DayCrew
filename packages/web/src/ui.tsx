import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const Button = ({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "text" | "danger" }) => (
  <button className={`${variant === "primary" ? "primary-button" : variant === "text" ? "text-button" : `secondary-button${variant === "danger" ? " danger" : ""}`} ${className}`.trim()} {...props} />
);

export const IconButton = ({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button className={`icon-button ${className}`.trim()} {...props} />;
export const Card = ({ className = "", ...props }: HTMLAttributes<HTMLElement>) => <section className={`card-surface ${className}`.trim()} {...props} />;
export const Badge = ({ tone = "neutral", className = "", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "danger" | "info" }) => <span className={`ui-badge badge-${tone} ${className}`.trim()} {...props} />;
export const StatusBadge = Badge;
export const Select = ({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={`ui-select ${className}`.trim()} {...props} />;
export const FormField = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => <label className="ui-form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
export const Tabs = ({ children, label }: { children: ReactNode; label: string }) => <nav className="ui-tabs" aria-label={label}>{children}</nav>;
export const EmptyState = ({ title, message, action }: { title: string; message: string; action?: ReactNode }) => <Card className="ui-state"><div><h2>{title}</h2><p>{message}</p></div>{action}</Card>;
export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => <Card className="ui-state error-state" role="alert"><div><h2>DayCrew needs a moment</h2><p>{message}</p></div>{onRetry && <Button onClick={onRetry}>Try again</Button>}</Card>;
export const LoadingState = ({ label = "Loading the latest Workspace state..." }: { label?: string }) => <div className="ui-loading" role="status"><span className="loading-orbit"><i /><i /><i /></span><p>{label}</p></div>;
export const Tooltip = ({ label, children }: { label: string; children: ReactNode }) => <span className="ui-tooltip" title={label}>{children}</span>;
export const Toast = ({ tone = "success", children }: { tone?: "success" | "error"; children: ReactNode }) => <div className={`ui-toast toast-${tone}`} role="status">{children}</div>;
export const Drawer = ({ open, label, children }: { open: boolean; label: string; children: ReactNode }) => open ? <aside className="ui-drawer" aria-label={label}>{children}</aside> : null;
export const Modal = ({ open, label, children, onClose }: { open: boolean; label: string; children: ReactNode; onClose: () => void }) => open ? <div className="ui-modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="ui-modal" role="dialog" aria-modal="true" aria-label={label}>{children}</section></div> : null;
