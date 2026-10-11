"use client";

/**
 * Optional wrapper: block app pages until user is signed in.
 * Use in layout or around main content.
 *
 * Example in layout.tsx:
 *   import AuthGate from "@/components/AuthGate";
 *   <SiteNavbar />
 *   <AuthGate><main>{children}</main></AuthGate>
 */

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

export default function AuthGate({
  children,
  allowHome = true,
}: {
  children: React.ReactNode;
  /** If true, "/" stays public */
  allowHome?: boolean;
}) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [path, setPath] = useState("/");

  useEffect(() => {
    setPath(typeof window !== "undefined" ? window.location.pathname : "/");
    (async () => {
      const { data } = await supabase.auth.getSession();
      setUser(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const publicPath =
    allowHome && (path === "/" || path === "");

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
