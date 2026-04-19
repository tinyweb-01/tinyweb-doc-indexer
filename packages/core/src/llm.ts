/**
 * Pluggable LLM / Vision provider interfaces.
 *
 * Adapters MUST go through these interfaces (never call OpenAI/Anthropic
 * directly) so the user can swap providers freely.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<TextPart | ImagePart>;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** Either a base64 data URL or a remote URL. */
  url: string;
  detail?: 'low' | 'high' | 'auto';
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** When set, provider should return parseable JSON matching the schema. */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  raw?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  json?<T = unknown>(req: ChatRequest): Promise<T>;
}

export interface VisionProvider {
  readonly name: string;
  /** Describe / OCR an image. Input may be a path, URL or data URL. */
  describeImage(image: string | Uint8Array, prompt?: string): Promise<string>;
  /** Optional: extract a structured table from an image. */
  extractTable?(image: string | Uint8Array): Promise<unknown>;
}

/** No-op provider for tests / `--no-llm` mode. */
export class NoopLLMProvider implements LLMProvider, VisionProvider {
  readonly name = 'noop';
  async chat(): Promise<ChatResponse> {
    return { content: '' };
  }
  async describeImage(): Promise<string> {
    return '';
  }
}
