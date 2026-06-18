import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import DeepSeekLLM from './deepseekLLM';

interface DeepSeekConfig {
  apiKey: string;
}

const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your DeepSeek API key',
    required: true,
    placeholder: 'DeepSeek API Key',
    env: 'DEEPSEEK_API_KEY',
    scope: 'server',
  },
];

// Base URL passed to the OpenAI-compatible client. The SDK appends the
// endpoint path (e.g. /chat/completions) itself, so this must NOT include it.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models';

// Known DeepSeek chat models, used as a fallback only if the /models endpoint
// cannot be reached. See https://api-docs.deepseek.com/
const fallbackChatModels: Model[] = [
  { key: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { key: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
];

class DeepSeekProvider extends BaseModelProvider<DeepSeekConfig> {
  constructor(id: string, name: string, config: DeepSeekConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    try {
      const res = await fetch(DEEPSEEK_MODELS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!res.ok) {
        throw new Error(
          `Failed to fetch DeepSeek models: ${res.status} ${res.statusText}`,
        );
      }

      const data = await res.json();

      const defaultChatModels: Model[] = (data.data ?? []).map((m: any) => ({
        key: m.id,
        name: m.id,
      }));

      return {
        embedding: [],
        chat: defaultChatModels.length > 0 ? defaultChatModels : fallbackChatModels,
      };
    } catch (err) {
      console.error('Error fetching DeepSeek models, using fallback list', err);
      return {
        embedding: [],
        chat: fallbackChatModels,
      };
    }
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading DeepSeek Chat Model. Invalid Model Selected',
      );
    }

    return new DeepSeekLLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: DEEPSEEK_BASE_URL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    throw new Error('DeepSeek Provider does not support embedding models.');
  }

  static parseAndValidate(raw: any): DeepSeekConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.apiKey)
      throw new Error('Invalid config provided. API key must be provided');

    return {
      apiKey: String(raw.apiKey),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'deepseek',
      name: 'DeepSeek',
    };
  }
}

export default DeepSeekProvider;
