import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  VisionProvider,
} from '@tinyweb_dev/doc-indexer-core';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  visionModel?: string;
  defaultTemperature?: number;
}

/**
 * OpenAI implementation of LLMProvider + VisionProvider.
 * Single class so callers can pass it as both `llm` and `vision`.
 */
export class OpenAIProvider implements LLMProvider, VisionProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly visionModel: string;
  private readonly defaultTemperature: number;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model ?? 'gpt-4o-mini';
    this.visionModel = opts.visionModel ?? this.model;
    this.defaultTemperature = opts.defaultTemperature ?? 0.2;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content } as const;
      }
      const parts = m.content.map((p) =>
        p.type === 'text'
          ? { type: 'text' as const, text: p.text }
          : { type: 'image_url' as const, image_url: { url: p.url, detail: p.detail } }
      );
      return { role: m.role, content: parts } as const;
    });

    const res = await this.client.chat.completions.create({
      model: req.model ?? this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      temperature: req.temperature ?? this.defaultTemperature,
      max_tokens: req.maxTokens,
      response_format: req.jsonSchema ? { type: 'json_object' } : undefined,
    });

    const choice = res.choices[0];
    return {
      content: choice?.message?.content ?? '',
      raw: res,
      usage: res.usage
        ? {
            promptTokens: res.usage.prompt_tokens,
            completionTokens: res.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async json<T = unknown>(req: ChatRequest): Promise<T> {
    const res = await this.chat({ ...req, jsonSchema: req.jsonSchema ?? {} });
    return JSON.parse(res.content) as T;
  }

  async describeImage(image: string | Uint8Array, prompt?: string): Promise<string> {
    const url = typeof image === 'string' ? image : toDataUrl(image);
    const res = await this.chat({
      model: this.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt ?? 'Describe the image in detail.' },
            { type: 'image', url },
          ],
        },
      ],
    });
    return res.content;
  }
}

function toDataUrl(buf: Uint8Array, mime = 'image/png'): string {
  const b64 = Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${b64}`;
}
