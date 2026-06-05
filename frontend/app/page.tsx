"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Database,
  KeyRound,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus
} from "lucide-react";

type Note = {
  id: string;
  owner: string;
  title: string;
  body: string;
  createdAt: string;
};

type Config = {
  database: string;
  container: string;
  vaultHost: string;
};

type User = {
  id: string;
  name: string;
  email: string;
};

type AuthMode = "signin" | "register";

const tokenStorageKey = "keyvault_app_token";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Home() {
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [title, setTitle] = useState("Production rollout checklist");
  const [body, setBody] = useState("Store application credentials in Key Vault and read them through workload identity.");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const sortedNotes = useMemo(() => notes, [notes]);
  const passwordHint = password.length >= 8;

  function authHeaders(activeToken = token) {
    return {
      Authorization: `Bearer ${activeToken}`,
      "Content-Type": "application/json"
    };
  }

  function validateAuthForm() {
    if (authMode === "register" && name.trim().length < 2) {
      return "Enter your full name.";
    }

    if (!emailPattern.test(email)) {
      return "Enter a valid email address.";
    }

    if (authMode === "register" && password.length < 8) {
      return "Use at least 8 characters for your password.";
    }

    if (authMode === "signin" && password.length === 0) {
      return "Enter your password.";
    }

    return "";
  }

  async function loadData(activeToken = token) {
    if (!activeToken) {
      return;
    }

    setLoading(true);
    setError("");
    try {
      const [configResponse, notesResponse] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/notes", { headers: authHeaders(activeToken) })
      ]);

      if (notesResponse.status === 401) {
        signOut();
        throw new Error("Your session expired. Please sign in again.");
      }

      if (!configResponse.ok || !notesResponse.ok) {
        throw new Error("The workspace could not be loaded.");
      }

      setConfig(await configResponse.json());
      setNotes(await notesResponse.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function restoreSession(savedToken: string) {
    try {
      const response = await fetch("/api/auth/me", { headers: authHeaders(savedToken) });
      if (!response.ok) {
        throw new Error("Session is no longer valid");
      }
      setToken(savedToken);
      setUser(await response.json());
      await loadData(savedToken);
    } catch {
      localStorage.removeItem(tokenStorageKey);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = validateAuthForm();
    if (validationMessage) {
      setAuthError(validationMessage);
      return;
    }

    setAuthLoading(true);
    setAuthError("");
    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authMode === "register" ? { name, email, password } : { email, password })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || "Authentication failed.");
      }

      localStorage.setItem(tokenStorageKey, payload.token);
      setToken(payload.token);
      setUser(payload.user);
      setPassword("");
      await loadData(payload.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setAuthLoading(false);
    }
  }

  async function createNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title, body })
      });

      if (!response.ok) {
        throw new Error("Could not create note.");
      }

      const created = await response.json();
      setNotes((current) => [created, ...current]);
      setTitle("");
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote(note: Note) {
    setError("");
    const response = await fetch(`/api/notes/${note.id}`, { method: "DELETE", headers: authHeaders() });
    if (!response.ok) {
      setError("Could not delete note.");
      return;
    }
    setNotes((current) => current.filter((item) => item.id !== note.id));
  }

  function signOut() {
    localStorage.removeItem(tokenStorageKey);
    setToken("");
    setUser(null);
    setNotes([]);
    setConfig(null);
  }

  useEffect(() => {
    const savedToken = localStorage.getItem(tokenStorageKey);
    if (savedToken) {
      restoreSession(savedToken);
    }
  }, []);

  if (!user) {
    return (
      <main className="landingShell">
        <nav className="topbar" aria-label="Primary">
          <div className="brandMark">
            <KeyRound size={22} />
            <span>VaultDesk</span>
          </div>
          <div className="navActions">
            <button className="ghostButton" type="button" onClick={() => setAuthMode("signin")}>
              Sign in
            </button>
            <button className="darkButton" type="button" onClick={() => setAuthMode("register")}>
              <UserPlus size={17} />
              Register
            </button>
          </div>
        </nav>

        <section className="heroGrid">
          <div className="heroCopy">
            <p className="eyebrow">Secure operations workspace</p>
            <h1>Protect credentials and keep delivery notes in one trusted place.</h1>
            <p className="lede">
              Sign in to manage private release notes backed by Azure Key Vault, Cosmos DB, and workload identity.
            </p>
            <div className="heroActions">
              <button className="primaryButton" type="button" onClick={() => setAuthMode("register")}>
                Get started
                <ArrowRight size={18} />
              </button>
              <button className="secondaryButton" type="button" onClick={() => setAuthMode("signin")}>
                <LockKeyhole size={18} />
                Sign in
              </button>
            </div>
            <div className="trustRow" aria-label="Security capabilities">
              <span>
                <CheckCircle2 size={16} />
                Token auth
              </span>
              <span>
                <CheckCircle2 size={16} />
                Secret-backed config
              </span>
              <span>
                <CheckCircle2 size={16} />
                Per-user records
              </span>
            </div>
          </div>

          <section className="authPanel" aria-label={authMode === "signin" ? "Sign in form" : "Registration form"}>
            <div className="authTabs" role="tablist" aria-label="Authentication mode">
              <button className={authMode === "signin" ? "active" : ""} type="button" onClick={() => setAuthMode("signin")}>
                Sign in
              </button>
              <button className={authMode === "register" ? "active" : ""} type="button" onClick={() => setAuthMode("register")}>
                Register
              </button>
            </div>

            <form className="authForm" onSubmit={submitAuth}>
              <div>
                <h2>{authMode === "signin" ? "Welcome back" : "Create your account"}</h2>
                <p>{authMode === "signin" ? "Access your secured workspace." : "Set up secure access in under a minute."}</p>
              </div>

              {authMode === "register" ? (
                <label>
                  Full name
                  <input
                    autoComplete="name"
                    minLength={2}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Avery Stone"
                    required
                  />
                </label>
              ) : null}

              <label>
                Email
                <input
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="avery@company.com"
                  required
                  type="email"
                />
              </label>

              <label>
                Password
                <input
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  minLength={authMode === "register" ? 8 : undefined}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  required
                  type="password"
                />
              </label>

              {authMode === "register" ? (
                <div className={passwordHint ? "passwordHint valid" : "passwordHint"}>
                  <CheckCircle2 size={15} />
                  At least 8 characters
                </div>
              ) : null}

              {authError ? <div className="error">{authError}</div> : null}

              <button className="primaryButton fullWidth" type="submit" disabled={authLoading}>
                {authMode === "signin" ? <LockKeyhole size={18} /> : <UserPlus size={18} />}
                {authLoading ? "Please wait" : authMode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="workspace">
        <aside className="sidebar">
          <div>
            <p className="eyebrow">Secure workspace</p>
            <h1>Private release notes</h1>
            <p className="lede">Signed-in records are isolated by account and backed by Key Vault configuration.</p>
          </div>

          <div className="signalGrid">
            <StatusCard icon={<KeyRound size={18} />} label="Secrets" value={config?.vaultHost || "Key Vault"} />
            <StatusCard icon={<Database size={18} />} label="Cosmos" value={config ? `${config.database}/${config.container}` : "NoSQL"} />
            <StatusCard icon={<ShieldCheck size={18} />} label="Identity" value="OIDC federation" />
          </div>
        </aside>

        <section className="panel">
          <header className="panelHeader">
            <div>
              <p className="eyebrow">Signed in as</p>
              <h2>{user.name}</h2>
              <span className="muted">{user.email}</span>
            </div>
            <div className="headerActions">
              <button className="iconButton" type="button" onClick={() => loadData()} aria-label="Refresh notes">
                <RefreshCw size={18} />
              </button>
              <button className="iconButton" type="button" onClick={signOut} aria-label="Sign out">
                <LogOut size={18} />
              </button>
            </div>
          </header>

          <form className="composer" onSubmit={createNote}>
            <input
              aria-label="Note title"
              maxLength={120}
              minLength={2}
              placeholder="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
            <textarea
              aria-label="Note body"
              maxLength={2000}
              placeholder="Body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              required
            />
            <button className="primaryButton" type="submit" disabled={saving}>
              <Plus size={18} />
              {saving ? "Saving" : "Create note"}
            </button>
          </form>

          {error ? <div className="error">{error}</div> : null}

          <div className="notes">
            {loading ? <p className="muted">Loading notes...</p> : null}
            {!loading && sortedNotes.length === 0 ? <p className="muted">No notes yet.</p> : null}
            {sortedNotes.map((note) => (
              <article className="note" key={note.id}>
                <div>
                  <h3>{note.title}</h3>
                  <time>{new Date(note.createdAt).toLocaleString()}</time>
                </div>
                <p>{note.body}</p>
                <button className="iconButton subtle" type="button" onClick={() => deleteNote(note)} aria-label={`Delete ${note.title}`}>
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function StatusCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="statusCard">
      <div className="statusIcon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
