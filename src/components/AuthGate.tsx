"use client";

import { useEffect, useState } from "react";

export default function AuthGate({
  children,
  allowHome = true,
}: {
  children: React.ReactNode;
  allowHome?: boolean;
}) {
  const [user, setUser] = useState<null | { id: string } | undefined>(undefined);
  const [path, setPath] = useState("/");

  useEffect(() => {
    setPath(typeof window !== "undefined" ? window.location.pathname : "/");
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        const json = await res.json();
        setUser(json.user ?? null);
      } catch {
        setUser(null);
      }
    })();
  }, []);

  const publicPath = allowHome && (path === "/" || path === "");

  if (user === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm py-20">
        Loading…
      </div>
    );
  }

  if (!user && !publicPath) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-lg font-medium text-white">Sign in to continue</p>
          <p className="text-sm text-gray-500">
            Create a free account or log in with email to use Watchlist, Charts, and Alerts.
          </p>
          <p className="text-xs text-orange-400">
            Use the orange <strong>Sign in</strong> button at the top left.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
