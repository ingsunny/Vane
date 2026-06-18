import { z } from 'zod';
import crypto from 'crypto';
import { applyPatch } from 'rfc6902';
import ModelRegistry from '@/lib/models/registry';
import { resolveDefaultModels } from '@/lib/models/defaults';
import SearchAgent from '@/lib/agents/search';
import { fastSearchGate, getDirectAnswerPrompt } from '@/lib/agents/search/fastGate';
import SessionManager from '@/lib/session';
import { Block, ChatTurnMessage, ResearchBlock } from '@/lib/types';
import { SearchSources } from '@/lib/agents/search/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, self-contained search endpoint.
 *
 * The caller sends only a `query` (plus optional history/mode/sources). The
 * server owns model selection (defaults to DeepSeek). The response is a
 * Server-Sent Events stream of high-level events:
 *
 *   event: start            data: { query }
 *   event: sources          data: { sources: [{ title, url }] }
 *   event: research         data: { steps: [...] }          (progress, repeats)
 *   event: research_complete data: {}
 *   event: widget           data: { type, params }
 *   event: answer           data: { delta, text }            (token stream)
 *   event: done             data: { answer, sources, research, widgets }
 *   event: error            data: { message }
 *
 * Each `done` event also carries the full consolidated result, so a caller can
 * ignore the streaming events entirely and just wait for `done` if preferred.
 */

const bodySchema = z.object({
  query: z.string().min(1, 'query is required'),
  history: z
    .array(z.tuple([z.enum(['human', 'assistant']), z.string()]))
    .optional()
    .default([]),
  mode: z.enum(['speed', 'balanced', 'quality']).optional().default('balanced'),
  sources: z
    .array(z.enum(['web', 'discussions', 'academic']))
    .optional()
    .default(['web']),
});

type ResearchStep = ResearchBlock['data']['subSteps'];

const sseEvent = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const POST = async (req: Request) => {
  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err: any) {
    return Response.json(
      {
        message: 'Invalid request body',
        error:
          err?.issues?.map((e: any) => ({
            path: e.path.join('.'),
            message: e.message,
          })) ?? String(err),
      },
      { status: 400 },
    );
  }

  let defaults;
  try {
    const registry = new ModelRegistry();
    defaults = await resolveDefaultModels(registry);

    const [llm, embedding] = await Promise.all([
      registry.loadChatModel(defaults.chat.providerId, defaults.chat.key),
      registry.loadEmbeddingModel(
        defaults.embedding.providerId,
        defaults.embedding.key,
      ),
    ]);

    const history: ChatTurnMessage[] = body.history.map(([role, content]) => ({
      role: role === 'human' ? 'user' : 'assistant',
      content,
    }));

    const agent = new SearchAgent();
    const session = SessionManager.createSession();

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // The client can disconnect at any time (e.g. the phone closes the AI
    // page). Once that happens the writer is dead, and any further write throws
    // ERR_INTERNAL_ASSERTION. Guard every write behind a `closed` flag and
    // swallow errors so a late agent event can never crash the process.
    let closed = false;
    const write = (event: string, data: unknown) => {
      if (closed) return;
      try {
        writer.write(encoder.encode(sseEvent(event, data)));
      } catch {
        closed = true;
      }
    };

    // --- in-memory mirror of the agent's blocks, for translation + final JSON
    const blocks = new Map<string, Block>();
    let answerBlockId: string | null = null;
    let answer = '';

    const sourcesFromBlocks = () => {
      const out: {
        title: string;
        url: string;
        content?: string;
        engines: string[];
      }[] = [];
      blocks.forEach((b) => {
        if (b.type === 'source') {
          (b.data as any[]).forEach((s) => {
            const md = s.metadata ?? {};
            if (md?.url) {
              out.push({
                title: md.title ?? md.url,
                url: md.url,
                content: s.content,
                engines: Array.isArray(md.engines) ? md.engines : [],
              });
            }
          });
        }
      });
      return out;
    };

    const researchSteps = (): ResearchStep => {
      for (const b of blocks.values()) {
        if (b.type === 'research') return (b as ResearchBlock).data.subSteps;
      }
      return [];
    };

    const widgetsFromBlocks = () => {
      const out: { type: string; params: any }[] = [];
      blocks.forEach((b) => {
        if (b.type === 'widget') {
          out.push({
            type: (b.data as any).widgetType,
            params: (b.data as any).params,
          });
        }
      });
      return out;
    };

    write('start', { query: body.query, mode: body.mode });

    // --- Fast gate: answer generic / known-knowledge queries directly from the
    // model, skipping SearXNG entirely. Only realtime / fresh-info queries fall
    // through to the full search agent below.
    const gate = await fastSearchGate({
      llm,
      query: body.query,
      chatHistory: history,
    });

    // Idempotent close for the fast path.
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      writer.close().catch(() => {});
    };

    if (!gate.needsSearch) {
      write('route', { search: false, reason: gate.reason });

      (async () => {
        try {
          const answerStream = llm.streamText({
            messages: [
              { role: 'system', content: getDirectAnswerPrompt('None') },
              ...history,
              { role: 'user', content: body.query },
            ],
          });

          for await (const chunk of answerStream) {
            if (closed) break; // client disconnected — stop streaming
            const delta = chunk.contentChunk || '';
            if (delta) {
              answer += delta;
              write('answer', { delta, text: answer });
            }
          }

          write('done', {
            answer,
            sources: [],
            research: [],
            widgets: [],
          });
        } catch (err: any) {
          write('error', { message: err?.message ?? String(err) });
        } finally {
          closeOnce();
        }
      })();

      req.signal.addEventListener('abort', closeOnce);

      return new Response(stream.readable, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    write('route', { search: true, reason: gate.reason });

    const disconnect = session.subscribe((event: string, data: any) => {
      if (event === 'data') {
        if (data.type === 'block') {
          // Deep-clone: the agent keeps mutating its own block objects in
          // place (e.g. `block.data += chunk` before emitting the patch), so
          // we must not alias them — otherwise our before/after diff sees the
          // already-mutated value and computes an empty delta.
          const block = structuredClone(data.block) as Block;
          blocks.set(block.id, block);

          if (block.type === 'source') {
            write('sources', { sources: sourcesFromBlocks() });
          } else if (block.type === 'research') {
            write('research', { steps: researchSteps() });
          } else if (block.type === 'widget') {
            write('widget', {
              type: (block.data as any).widgetType,
              params: (block.data as any).params,
            });
          } else if (block.type === 'text') {
            // First chunk of the streamed answer.
            answerBlockId = block.id;
            const delta = block.data as string;
            answer += delta;
            write('answer', { delta, text: answer });
          }
        } else if (data.type === 'updateBlock') {
          const block = blocks.get(data.blockId);
          if (!block) return;

          if (block.id === answerBlockId) {
            const before = (block as any).data as string;
            applyPatch(block, data.patch);
            const after = (block as any).data as string;
            const delta = after.slice(before.length);
            answer = after;
            if (delta) write('answer', { delta, text: answer });
          } else {
            applyPatch(block, data.patch);
            if (block.type === 'research') {
              write('research', { steps: researchSteps() });
            }
          }
        } else if (data.type === 'researchComplete') {
          write('research_complete', {});
        }
      } else if (event === 'end') {
        write('done', {
          answer,
          sources: sourcesFromBlocks(),
          research: researchSteps(),
          widgets: widgetsFromBlocks(),
        });
        finish();
      } else if (event === 'error') {
        write('error', { message: data?.data ?? 'An error occurred' });
        finish();
      }
    });

    // Idempotent teardown: stop listening, mark closed, close the writer once.
    function finish() {
      if (closed) return;
      closed = true;
      disconnect();
      session.removeAllListeners();
      writer.close().catch(() => {});
    }

    agent
      .searchAsync(session, {
        chatHistory: history,
        followUp: body.query,
        chatId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        config: {
          llm,
          embedding,
          sources: body.sources as SearchSources[],
          mode: body.mode,
          fileIds: [],
          systemInstructions: 'None',
        },
      })
      .catch((err) => {
        console.error('Public search agent failed:', err);
        session.emit('error', { data: String(err?.message ?? err) });
      });

    req.signal.addEventListener('abort', finish);

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    console.error('An error occurred in public search endpoint:', err);
    return Response.json(
      { message: err?.message ?? 'An error occurred while processing request' },
      { status: 500 },
    );
  }
};
