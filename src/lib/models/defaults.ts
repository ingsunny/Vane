import ModelRegistry from './registry';
import { ModelWithProvider } from './types';

/**
 * The provider type preferred as the default for the public API. Change this
 * to switch which provider powers the public endpoint.
 */
const PREFERRED_CHAT_PROVIDER_TYPE = 'deepseek';

export type ResolvedDefaults = {
  chat: ModelWithProvider;
  embedding: ModelWithProvider;
};

/**
 * Resolve the server-side default chat + embedding models for the public API.
 * The caller never picks a model — this is entirely server-controlled.
 *
 * Chat: prefers PREFERRED_CHAT_PROVIDER_TYPE (DeepSeek), else the first
 * provider that exposes any chat model.
 * Embedding: the first provider that exposes any embedding model (DeepSeek has
 * none, so this naturally falls through to OpenAI / transformers / etc.).
 */
export const resolveDefaultModels = async (
  registry: ModelRegistry,
): Promise<ResolvedDefaults> => {
  const lists = await Promise.all(
    registry.activeProviders.map(async (p) => {
      try {
        const models = await p.provider.getModelList();
        return { id: p.id, type: p.type, models };
      } catch {
        return { id: p.id, type: p.type, models: { chat: [], embedding: [] } };
      }
    }),
  );

  const withChat = lists.filter(
    (l) => l.models.chat.length > 0 && !l.models.chat.some((m) => m.key === 'error'),
  );

  const chatProvider =
    withChat.find((l) => l.type === PREFERRED_CHAT_PROVIDER_TYPE) ??
    withChat[0];

  if (!chatProvider) {
    throw new Error(
      'No chat model is configured. Add a provider with a chat model in settings.',
    );
  }

  const embeddingProvider = lists.find((l) => l.models.embedding.length > 0);

  if (!embeddingProvider) {
    throw new Error(
      'No embedding model is configured. Add a provider with an embedding model in settings.',
    );
  }

  return {
    chat: {
      providerId: chatProvider.id,
      key: chatProvider.models.chat[0].key,
    },
    embedding: {
      providerId: embeddingProvider.id,
      key: embeddingProvider.models.embedding[0].key,
    },
  };
};
