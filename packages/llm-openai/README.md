# @tinyweb_dev/doc-indexer-llm-openai

OpenAI provider implementing both `LLMProvider` and `VisionProvider`.

```ts
import { OpenAIProvider } from '@tinyweb_dev/doc-indexer-llm-openai';
const llm = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' });
```
