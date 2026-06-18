# Public Search API — `POST /api/v1/search`

A single endpoint that exposes the full Vane pipeline: live research progress
(search queries, results, the engines each came from), streamed answer tokens,
and a final consolidated result.

The caller only sends a `query`. **Model selection is entirely server-side**
(defaults to DeepSeek; configured in `src/lib/models/defaults.ts`). No auth.

## Request

```http
POST /api/v1/search
Content-Type: application/json
```

```jsonc
{
  "query": "what is deepseek v4",        // required
  "mode": "balanced",                     // optional: "speed" | "balanced" | "quality" (default "balanced")
  "sources": ["web"],                     // optional: subset of "web" | "discussions" | "academic" (default ["web"])
  "history": [                            // optional prior turns
    ["human", "hello"],
    ["assistant", "Hi! How can I help?"]
  ]
}
```

## Response

`Content-Type: text/event-stream` — Server-Sent Events. Each event has a name
and a JSON `data` payload:

| event               | when                       | data |
|---------------------|----------------------------|------|
| `start`             | immediately                | `{ query, mode }` |
| `route`             | right after `start`        | `{ search: boolean, reason }` — whether the query took the fast (no-search) path or the full search path |
| `sources`           | when sources are resolved  | `{ sources: [{ title, url, content, engines }] }` |
| `research`          | repeatedly, as it progresses | `{ steps: [...] }` — the research sub-steps (searching queries, search_results with per-result `engines`, reading, reasoning) |
| `research_complete` | research finished          | `{}` |
| `widget`            | a widget was produced      | `{ type, params }` (e.g. weather, stock) |
| `answer`            | per streamed token         | `{ delta, text }` — `delta` is the new chunk, `text` is the full answer so far |
| `done`              | the very end               | `{ answer, sources, research, widgets }` — the complete consolidated result |
| `error`             | on failure                 | `{ message }` |

> The `done` event carries the entire result, so a caller that doesn't care
> about streaming can ignore every other event and just read `done`.

## Fast path vs search path

A lightweight gate runs first (`src/lib/agents/search/fastGate.ts`) and emits a
`route` event:

- **Generic / known-knowledge** queries — math, definitions, explanations,
  writing, greetings, the current date/time — are answered **directly from the
  model, skipping SearXNG entirely** (`route.search = false`). This is the fast
  path: `start → route → answer… → done`, with empty `sources`/`research`.
- **Realtime / fresh-info** queries — latest news, prices, scores, "current
  …", anything time-sensitive — go through the **full search pipeline**
  (`route.search = true`): `start → route → research… → sources → answer… → done`.

The gate is specific to this public endpoint; the main web app's search
behavior is unchanged.

## Examples

### cURL (stream)

```bash
curl -N -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query":"latest news about deepseek v4","mode":"speed"}'
```

### JavaScript (browser / Node) — consume the stream

```js
const res = await fetch('http://localhost:3000/api/v1/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'what is deepseek v4' }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  // SSE frames are separated by a blank line
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    const event = frame.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? '{}');

    if (event === 'research') console.log('progress:', data.steps.at(-1)?.type);
    if (event === 'sources') console.log('sources:', data.sources.length);
    if (event === 'answer') process.stdout.write(data.delta);
    if (event === 'done') console.log('\n--- final ---', data);
  }
}
```

### Just want the final answer (ignore streaming)

Read frames until you hit `event: done`, then use its `data`.

## Configuring the default model

Edit `PREFERRED_CHAT_PROVIDER_TYPE` in
[`src/lib/models/defaults.ts`](../../../../lib/models/defaults.ts). It prefers a
provider of that type (currently `deepseek`); if none is configured it falls
back to the first provider that has a chat model. An embedding model from any
configured provider is used for relevance ranking.
