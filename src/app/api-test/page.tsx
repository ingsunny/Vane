'use client';

/**
 * Throwaway test page for the public POST /api/v1/search endpoint.
 *
 * This whole folder (src/app/api-test/) is self-contained — delete it any time
 * and nothing else is affected. It renders as a full-screen overlay so it does
 * not depend on the app sidebar/chrome from the root layout.
 */

import { useRef, useState } from 'react';

type SourceItem = {
  title: string;
  url: string;
  content?: string;
  engines: string[];
};

type StreamEvent = {
  name: string;
  data: any;
  at: number;
};

const badge =
  'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize bg-sky-500/10 text-sky-600 border border-sky-500/30';

export default function ApiTestPage() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'speed' | 'balanced' | 'quality'>('speed');
  const [running, setRunning] = useState(false);

  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [steps, setSteps] = useState<any[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [doneData, setDoneData] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number>(0);

  const reset = () => {
    setAnswer('');
    setSources([]);
    setSteps([]);
    setEvents([]);
    setDoneData(null);
    setErrorMsg(null);
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const run = async () => {
    if (!query.trim() || running) return;
    reset();
    setRunning(true);
    startRef.current = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;

    const pushEvent = (name: string, data: any) =>
      setEvents((prev) => [
        ...prev,
        { name, data, at: Date.now() - startRef.current },
      ]);

    try {
      const res = await fetch('/api/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;
          const name = frame.match(/^event: (.*)$/m)?.[1] ?? 'message';
          const dataStr = frame.match(/^data: (.*)$/m)?.[1] ?? '{}';
          let data: any = {};
          try {
            data = JSON.parse(dataStr);
          } catch {
            data = { raw: dataStr };
          }

          pushEvent(name, data);

          if (name === 'answer') {
            setAnswer(data.text ?? '');
          } else if (name === 'sources') {
            setSources(data.sources ?? []);
          } else if (name === 'research') {
            setSteps(data.steps ?? []);
          } else if (name === 'done') {
            setDoneData(data);
          } else if (name === 'error') {
            setErrorMsg(data.message ?? 'Unknown error');
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setErrorMsg(String(err?.message ?? err));
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] overflow-auto bg-zinc-950 text-zinc-100 font-mono">
      <div className="max-w-5xl mx-auto p-6 space-y-5">
        <header className="space-y-1">
          <h1 className="text-lg font-bold text-sky-400">
            /api/v1/search — live test
          </h1>
          <p className="text-xs text-zinc-500">
            Throwaway page. Delete <code>src/app/api-test/</code> any time.
          </p>
        </header>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="Type a query and hit Enter…"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as any)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-2 text-sm"
          >
            <option value="speed">speed</option>
            <option value="balanced">balanced</option>
            <option value="quality">quality</option>
          </select>
          {running ? (
            <button
              onClick={stop}
              className="bg-red-600 hover:bg-red-500 rounded-md px-4 py-2 text-sm font-semibold"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!query.trim()}
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-md px-4 py-2 text-sm font-semibold"
            >
              Search
            </button>
          )}
        </div>

        {errorMsg && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-md p-3 text-sm">
            {errorMsg}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-5">
          {/* Left: research + sources */}
          <div className="space-y-5">
            {/* Research progress */}
            <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-zinc-300 mb-2">
                Research progress{' '}
                {running && (
                  <span className="text-sky-400 animate-pulse">●</span>
                )}
              </h2>
              {steps.length === 0 ? (
                <p className="text-xs text-zinc-600">No research yet.</p>
              ) : (
                <ul className="space-y-2">
                  {steps.map((step: any) => (
                    <li key={step.id} className="text-xs">
                      <span className="text-sky-400">{step.type}</span>
                      {step.type === 'searching' &&
                        Array.isArray(step.searching) && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {step.searching.map((q: string, i: number) => (
                              <span
                                key={i}
                                className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300"
                              >
                                {q}
                              </span>
                            ))}
                          </div>
                        )}
                      {(step.type === 'search_results' ||
                        step.type === 'reading') &&
                        Array.isArray(step.reading) && (
                          <ul className="mt-1 space-y-1">
                            {step.reading
                              .slice(0, 6)
                              .map((r: any, i: number) => (
                                <li
                                  key={i}
                                  className="text-zinc-400 flex flex-wrap items-center gap-1"
                                >
                                  <span className="line-clamp-1">
                                    {r.metadata?.title}
                                  </span>
                                  {(r.metadata?.engines ?? []).map(
                                    (e: string) => (
                                      <span key={e} className={badge}>
                                        {e}
                                      </span>
                                    ),
                                  )}
                                </li>
                              ))}
                          </ul>
                        )}
                      {step.type === 'reasoning' && step.reasoning && (
                        <p className="text-zinc-500 mt-1">{step.reasoning}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Sources */}
            <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-zinc-300 mb-2">
                Sources ({sources.length})
              </h2>
              {sources.length === 0 ? (
                <p className="text-xs text-zinc-600">No sources.</p>
              ) : (
                <ul className="space-y-2">
                  {sources.map((s, i) => (
                    <li key={i} className="text-xs">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline line-clamp-1"
                      >
                        {s.title}
                      </a>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {s.engines.map((e) => (
                          <span key={e} className={badge}>
                            {e}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Right: answer + raw event log */}
          <div className="space-y-5">
            {/* Answer */}
            <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-zinc-300 mb-2">
                Answer{' '}
                {running && answer && (
                  <span className="text-sky-400 animate-pulse">▍</span>
                )}
              </h2>
              <pre className="text-xs text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed">
                {answer || (
                  <span className="text-zinc-600 font-mono">
                    Answer will stream here…
                  </span>
                )}
              </pre>
            </section>

            {/* Raw event log */}
            <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-zinc-300 mb-2">
                Raw event stream ({events.length})
              </h2>
              <div className="max-h-72 overflow-auto space-y-1">
                {events.map((ev, i) => (
                  <div key={i} className="text-[11px] flex gap-2">
                    <span className="text-zinc-600 w-12 shrink-0">
                      {ev.at}ms
                    </span>
                    <span
                      className={
                        ev.name === 'error'
                          ? 'text-red-400 w-32 shrink-0'
                          : 'text-emerald-400 w-32 shrink-0'
                      }
                    >
                      {ev.name}
                    </span>
                    <span className="text-zinc-500 truncate">
                      {ev.name === 'answer'
                        ? JSON.stringify({ delta: ev.data.delta })
                        : JSON.stringify(ev.data).slice(0, 120)}
                    </span>
                  </div>
                ))}
                {events.length === 0 && (
                  <p className="text-xs text-zinc-600">No events yet.</p>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Final consolidated done payload */}
        {doneData && (
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-zinc-300 mb-2">
              Final <code>done</code> payload
            </h2>
            <pre className="text-[11px] text-zinc-400 overflow-auto max-h-72">
              {JSON.stringify(doneData, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
