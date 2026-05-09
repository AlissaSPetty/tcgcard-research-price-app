import type { ReactNode } from "react";
import { useIsRestoring } from "@tanstack/react-query";

export function PersistHydrationGate({ children }: { children: ReactNode }) {
  const isRestoring = useIsRestoring();
  if (isRestoring) {
    return (
      <div className="app-loading-shell" aria-busy="true" aria-live="polite">
        <div className="auth-toolbar app-loading-toolbar" />
        <div className="app-loading-inner">
          <div className="app-loading-spinner" aria-hidden />
          <p className="app-loading-title">Pokemon Cards</p>
          <p className="app-loading-sub">Restoring cache…</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
