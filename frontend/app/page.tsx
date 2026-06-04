"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Database, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

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

const owner = "demo-user";

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [title, setTitle] = useState("AKS rollout checklist");
  const [body, setBody] = useState("Created through Next.js, stored in Cosmos DB, authenticated through Key Vault.");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const sortedNotes = useMemo(() => notes, [notes]);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const [configResponse, notesResponse] = await Promise.all([
        fetch("/api/config"),
        fetch(`/api/notes?owner=${owner}`)
      ]);

      if (!configResponse.ok || !notesResponse.ok) {
        throw new Error("The API could not load the demo data.");
      }

      setConfig(await configResponse.json());
      setNotes(await notesResponse.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function createNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, title, body })
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
    const response = await fetch(`/api/notes/${note.id}?owner=${note.owner}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete note.");
      return;
    }
    setNotes((current) => current.filter((item) => item.id !== note.id));
  }

  useEffect(() => {
    loadData();
  }, []);

  return (
    <main className="shell">
      <section className="workspace">
        <aside className="sidebar">
          <div>
            <p className="eyebrow">Azure SDK demo</p>
            <h1>Key Vault backed Cosmos notes</h1>
            <p className="lede">
              A monolithic FastAPI and Next.js app for AKS with OIDC and Azure Workload Identity.
            </p>
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
              <p className="eyebrow">Demo user</p>
              <h2>{owner}</h2>
            </div>
            <button className="iconButton" type="button" onClick={loadData} aria-label="Refresh notes">
              <RefreshCw size={18} />
            </button>
          </header>

          <form className="composer" onSubmit={createNote}>
            <input
              aria-label="Note title"
              placeholder="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
            <textarea
              aria-label="Note body"
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
