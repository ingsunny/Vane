import z from 'zod';
import { parse } from 'partial-json';
import { repairJson } from '@toolsycc/json-repair';
import OpenAILLM from '../openai/openaiLLM';
import { GenerateObjectInput } from '../../types';

/**
 * DeepSeek is OpenAI-compatible for chat/streaming, so we inherit those from
 * OpenAILLM. It does NOT support OpenAI's structured-output features though:
 *   - response_format: { type: 'json_schema' }  -> "This response_format type
 *     is unavailable now"
 *   - the /responses API used by OpenAILLM.streamObject
 *
 * DeepSeek only supports JSON mode (response_format: { type: 'json_object' }),
 * which requires that the prompt mention "json" and describe the desired shape.
 * So we override generateObject/streamObject to use JSON mode and parse the
 * result against the provided zod schema ourselves.
 * See https://api-docs.deepseek.com/guides/json_mode
 */
class DeepSeekLLM extends OpenAILLM {
  private buildJsonMessages(input: GenerateObjectInput) {
    const jsonSchema = z.toJSONSchema(input.schema);

    const messages = this.convertToOpenAIMessages(input.messages);

    // DeepSeek requires the word "json" in the context and benefits from being
    // told the exact schema. Prepend a system instruction describing it.
    const schemaInstruction = {
      role: 'system' as const,
      content:
        'You must respond with a single valid JSON object and nothing else. ' +
        'Do not wrap it in markdown code fences. The JSON object must conform ' +
        `to the following JSON schema:\n${JSON.stringify(jsonSchema)}`,
    };

    return [schemaInstruction, ...messages];
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const response = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.buildJsonMessages(input),
      response_format: { type: 'json_object' },
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      // DeepSeek uses `max_tokens` (not `max_completion_tokens`). JSON mode can
      // return an empty body if the budget is too small — especially on the
      // thinking models which spend tokens reasoning first — so give it room.
      max_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens ?? 8192,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
    });

    const content = response.choices?.[0]?.message?.content;

    if (!content || content.trim().length === 0) {
      throw new Error(
        `DeepSeek returned an empty response (finish_reason: ${response.choices?.[0]?.finish_reason ?? 'unknown'}).`,
      );
    }

    try {
      return input.schema.parse(
        JSON.parse(
          repairJson(content, {
            extractJson: true,
          }) as string,
        ),
      ) as T;
    } catch (err) {
      throw new Error(
        `Error parsing response from DeepSeek: ${err}. Raw content: ${content.slice(0, 500)}`,
      );
    }
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.buildJsonMessages(input),
      response_format: { type: 'json_object' },
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens ?? 8192,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        recievedObj += chunk.choices[0].delta.content || '';

        try {
          yield parse(recievedObj) as T;
        } catch (err) {
          yield {} as T;
        }
      }
    }
  }
}

export default DeepSeekLLM;
