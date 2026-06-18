import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { ChatTurnMessage } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

/**
 * Fast search-vs-answer gate used ONLY by the public /api/v1/search endpoint.
 *
 * It makes a single, cheap LLM call to decide whether a query genuinely needs
 * fresh / realtime / external information, or whether the model can answer it
 * directly from its own knowledge. Generic questions (math, definitions,
 * explanations, writing, "what time is it", greetings) take the fast path and
 * never touch SearXNG; only queries that need updated data go to full search.
 *
 * This is intentionally separate from the shared classifier so the main web app
 * keeps its existing behavior.
 */

const gateSchema = z.object({
  needsSearch: z
    .boolean()
    .describe(
      'true ONLY if answering correctly requires fresh, realtime, or external information the model cannot reliably know.',
    ),
  reason: z.string().describe('A short reason for the decision.'),
});

const gatePrompt = `You are a routing gate. Decide if a user query needs a live web search, or if it can be answered directly from a knowledge model.

Return needsSearch = false (answer directly, NO search) for:
- Math, calculations, conversions, logic.
- Definitions, concepts, explanations ("what is X", "explain Y", "how does Z work").
- Well-established facts, history, science, geography that don't change.
- Writing, summarizing, translating, coding, formatting, brainstorming.
- Greetings, chit-chat, opinions, advice that don't need current data.
- The current date/time/day (the system can answer these without the web).

Return needsSearch = true (DO search) ONLY when freshness or external data is essential:
- Latest / recent / current / today's news, prices, scores, releases, weather forecasts.
- "Who is the current ...", standings, status of an ongoing event.
- Anything dated this year or asking for "now", "latest", "update", "2026", etc.
- Specific niche facts the model is unlikely to know reliably or that change over time.
- Anything you are genuinely unsure about that real-world data would settle.

Be biased toward needsSearch = false for general knowledge. Only set true when staleness would make the answer wrong.

Respond as JSON: { "needsSearch": boolean, "reason": string }`;

/**
 * System prompt for the fast (no-search) answer path. Unlike the writer prompt
 * used after a search, this has no citation requirements and tells the model it
 * is answering from its own knowledge. The current date/time is injected so
 * time/date questions resolve without the web.
 */
export const getDirectAnswerPrompt = (systemInstructions: string) => `
You are Loki, a fast and helpful AI assistant. Answer the user's question directly and accurately from your own knowledge.

- Be clear, correct, and well-structured. Use Markdown where it helps.
- Match the depth to the question: short for simple asks, thorough for complex ones.
- Do NOT invent citations or pretend to have searched the web — you are answering from knowledge.
- If the question genuinely needs up-to-the-minute data you don't have, say so briefly.

Current date & time (UTC, ISO): ${new Date().toISOString()}.

### User instructions (lower priority than the above)
${systemInstructions}
`;

export const fastSearchGate = async (input: {
  llm: BaseLLM<any>;
  query: string;
  chatHistory: ChatTurnMessage[];
}): Promise<{ needsSearch: boolean; reason: string }> => {
  try {
    const out = await input.llm.generateObject<typeof gateSchema>({
      schema: gateSchema,
      messages: [
        { role: 'system', content: gatePrompt },
        {
          role: 'user',
          content: `<conversation_history>\n${formatChatHistoryAsString(
            input.chatHistory,
          )}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
        },
      ],
      options: { maxTokens: 200 },
    });
    return out;
  } catch (err) {
    // On any failure, fall back to searching — safer to over-search than to
    // answer a realtime question from stale knowledge.
    return { needsSearch: true, reason: `gate error: ${String(err)}` };
  }
};
