import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { applyThemeToDocument, type Theme } from "./theme";
import PokemonDashboard from "./PokemonDashboard";
import CardDetailPage from "./CardDetailPage";

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
const supabase = createClient(url, anon);

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const d = document.documentElement.dataset.theme;
    return d === "dark" ? "dark" : "light";
  });
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session: s } }) => setSession(s))
      .finally(() => setAuthReady(true));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  async function signIn(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (!url || !anon) {
    return (
      <p className="error">
        Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this app.
      </p>
    );
  }

  if (!authReady) {
    return (
      <div className="app-loading-shell" aria-busy="true" aria-live="polite">
        <div className="auth-toolbar app-loading-toolbar">
          <button
            type="button"
            className="theme-toggle secondary"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
        </div>
        <div className="app-loading-inner">
          <div className="app-loading-spinner" aria-hidden />
          <p className="app-loading-title">Pokemon Cards</p>
          <p className="app-loading-sub">Loading…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-shell app-shell--auth">
        <div className="auth-toolbar">
          <button
            type="button"
            className="theme-toggle secondary"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
        </div>
        <h1 className="app-title">Pokemon Cards</h1>
        <section>
          <h2>Sign in</h2>
          <form onSubmit={signIn}>
            <label>Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
            <label>Password</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
            />
            <button type="submit">Sign in</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/card/:cardId"
        element={
          <CardDetailPage
            session={session}
            theme={theme}
            setTheme={setTheme}
            onSignOut={signOut}
          />
        }
      />
      <Route
        path="*"
        element={
          <PokemonDashboard
            session={session}
            theme={theme}
            setTheme={setTheme}
            onSignOut={signOut}
          />
        }
      />
    </Routes>
  );
}
