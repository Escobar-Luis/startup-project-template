import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { PROJECT, footerText } from "./project";

interface Answer {
  text: string;
  source: string;
  model: string;
  banner?: string;
  example?: string;
}

export function App() {
  const [prompt, setPrompt] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasClip, setHasClip] = useState(false);

  useEffect(() => {
    document.title = PROJECT.title;
    fetch("/api/examples")
      .then((r) => (r.ok ? r.json() : { examples: [] }))
      .then((b: { examples: string[] }) => setExamples(b.examples))
      .catch(() => setExamples([]));
    // The clip exists only when CI rendered it (ship.yml render-clip).
    fetch("/how-it-works.mp4", { method: "HEAD" })
      .then((r) => setHasClip(r.ok && (r.headers.get("content-type") ?? "").startsWith("video/")))
      .catch(() => setHasClip(false));
  }, []);

  async function ask(text: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      const body = isJson ? await res.json() : null;
      if (!res.ok || !body) setError(body?.error ?? `error ${res.status}`);
      else setAnswer(body as Answer);
    } catch {
      setError("The app is waking up. Try again in a few seconds.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (prompt.trim()) void ask(prompt.trim());
  }

  const theme = {
    "--brand": PROJECT.colors.primary,
    "--accent": PROJECT.colors.accent,
    "--page": PROJECT.colors.background,
    "--ink": PROJECT.colors.text,
  } as CSSProperties;

  return (
    <div style={theme} className="min-h-screen bg-page text-ink flex flex-col">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
        <h1 className="text-3xl font-semibold text-brand">{PROJECT.title}</h1>
        <p className="mt-3 text-lg leading-relaxed">{PROJECT.problem}</p>
        <nav className="mt-3 flex gap-4 text-sm">
          <a className="text-brand underline" href="/explainer.html">
            How this works
          </a>
          {hasClip && (
            <a className="text-brand underline" href="/how-it-works.mp4">
              30-second video
            </a>
          )}
        </nav>

        {examples.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium uppercase tracking-wide opacity-70">
              {PROJECT.examples_title ?? "Try an example"}
            </h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPrompt(ex)}
                  className="rounded-full border border-brand/40 px-3 py-1 text-sm hover:bg-brand/10"
                >
                  {ex}
                </button>
              ))}
            </div>
          </section>
        )}

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            maxLength={2000}
            className="w-full rounded-lg border border-ink/20 bg-white p-3"
            placeholder="Type a request"
          />
          <button
            type="submit"
            disabled={busy || !prompt.trim()}
            className="self-start rounded-lg bg-brand px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {busy ? "Working" : "Run"}
          </button>
        </form>

        {error && <p className="mt-4 text-red-700">{error}</p>}

        {answer && (
          <section className="mt-6 rounded-lg border border-ink/10 bg-white p-4">
            {answer.banner && (
              <p role="status" className="mb-3 rounded-md bg-accent/15 px-3 py-2 text-sm font-medium">
                {answer.banner}
                {answer.example ? `: "${answer.example}"` : ""}
              </p>
            )}
            <p className="whitespace-pre-wrap">{answer.text}</p>
            <p className="mt-3 text-xs opacity-60">
              {answer.source === "demo" ? "recorded run" : "live"} · {answer.model}
            </p>
          </section>
        )}
      </main>
      <footer className="border-t border-ink/10 px-4 py-4 text-center text-sm opacity-70">{footerText()}</footer>
    </div>
  );
}
