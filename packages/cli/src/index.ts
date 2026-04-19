import { Command } from 'commander';
import kleur from 'kleur';
import * as path from 'node:path';
import {
  ConsoleLogger,
  FsStorage,
  Indexer,
  NoopLLMProvider,
  type LLMProvider,
  type SourceAdapter,
  type SourceInput,
  type SourceType,
  type VisionProvider,
} from '@tinyweb_dev/doc-indexer-core';

function isVisionProvider(p: unknown): p is VisionProvider {
  return !!p && typeof (p as VisionProvider).describeImage === 'function';
}

const program = new Command();

program
  .name('doc-index')
  .description('Universal document indexing CLI (excel, pdf, image, url, gsheet, gdoc, ...)')
  .version('0.0.1');

program
  .argument('<input>', 'File path, glob, or URL to index')
  .option('-t, --type <type>', 'Force source type (auto by default)', 'auto')
  .option('-o, --out <dir>', 'Output directory', './out')
  .option('--llm <spec>', 'LLM provider spec, e.g. "openai:gpt-4o-mini"')
  .option('--no-llm', 'Disable all LLM calls (extraction-only mode)')
  .option('--render', 'Enable visual snapshot rendering when adapter supports it')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (input: string, opts) => {
    try {
      await runIndex(input, opts);
    } catch (err) {
      console.error(kleur.red('✖ '), (err as Error).message);
      if (opts.verbose) console.error(err);
      process.exit(1);
    }
  });

program
  .command('inspect <indexJson>')
  .description('Print a summary of an existing IndexedDocument JSON file.')
  .action(async (indexJson: string) => {
    const { promises: fs } = await import('node:fs');
    const raw = await fs.readFile(indexJson, 'utf8');
    const doc = JSON.parse(raw);
    console.log(kleur.bold(`${doc.title}  `) + kleur.gray(`(${doc.id})`));
    console.log(`  type:   ${doc.sourceType}`);
    console.log(`  chunks: ${doc.chunks?.length ?? 0}`);
    console.log(`  assets: ${doc.assets?.length ?? 0}`);
    console.log(`  tokens: ~${doc.stats?.tokenEstimate ?? 0}`);
  });

program.parseAsync(process.argv);

// ---------------------------------------------------------------------------

async function runIndex(input: string, opts: Record<string, unknown>): Promise<void> {
  const verbose = !!opts.verbose;
  const logger = new ConsoleLogger(verbose);
  const outDir = path.resolve(String(opts.out ?? './out'));
  const storage = new FsStorage(outDir);

  const llm = await resolveLLM(opts);
  const adapters = await loadAdapters(verbose);

  const vision = isVisionProvider(llm) ? llm : undefined;
  const indexer = new Indexer({ adapters, llm, vision, storage, logger });

  const source = buildSource(input, String(opts.type ?? 'auto'));

  console.log(kleur.cyan('▶ '), `Indexing ${kleur.bold(input)} -> ${outDir}`);
  const startedAt = Date.now();

  for await (const ev of indexer.indexStream(source, { options: { render: !!opts.render } })) {
    switch (ev.kind) {
      case 'progress':
        if (verbose) console.log(kleur.gray(`  ${ev.pct}% ${ev.message ?? ''}`));
        break;
      case 'log':
        logger[ev.level](ev.message);
        break;
      case 'chunk':
        if (verbose) console.log(kleur.gray(`  + chunk ${ev.chunk.id} (${ev.chunk.type})`));
        break;
      case 'done': {
        const indexRef = await storage.putJson(ev.doc.id, 'index.json', ev.doc);
        const ms = Date.now() - startedAt;
        console.log(
          kleur.green('✔ '),
          `Indexed ${ev.doc.chunks.length} chunks in ${ms}ms → ${storage.resolve(indexRef)}`
        );
        break;
      }
      default:
        break;
    }
  }
}

function buildSource(input: string, type: string): SourceInput {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const sourceType = (type === 'auto' ? 'auto' : (type as SourceType)) as
    | SourceType
    | 'auto';
  return isUrl ? { url: input, type: sourceType } : { path: input, type: sourceType };
}

async function resolveLLM(opts: Record<string, unknown>): Promise<LLMProvider> {
  if (opts.llm === false) return new NoopLLMProvider();
  const spec = (opts.llm as string | undefined) ?? process.env.DOC_INDEXER_LLM;
  if (!spec) {
    // Default to OpenAI when API key present, otherwise noop.
    if (process.env.OPENAI_API_KEY) {
      const { OpenAIProvider } = await import('@tinyweb_dev/doc-indexer-llm-openai');
      return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY });
    }
    return new NoopLLMProvider();
  }
  const [vendor, model] = spec.split(':');
  if (vendor === 'openai') {
    const { OpenAIProvider } = await import('@tinyweb_dev/doc-indexer-llm-openai');
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: model ?? undefined,
    });
  }
  throw new Error(`Unknown LLM vendor "${vendor}". Supported: openai`);
}

async function loadAdapters(verbose: boolean): Promise<SourceAdapter[]> {
  const adapters: SourceAdapter[] = [];
  try {
    const { ExcelAdapter } = await import('@tinyweb_dev/doc-indexer-excel');
    adapters.push(new ExcelAdapter());
  } catch (err) {
    if (verbose) console.warn('excel adapter not available:', (err as Error).message);
  }
  try {
    const { PdfAdapter } = await import('@tinyweb_dev/doc-indexer-pdf');
    adapters.push(new PdfAdapter());
  } catch (err) {
    if (verbose) console.warn('pdf adapter not available:', (err as Error).message);
  }
  // Future: url, image, gsheet, gdoc, docx, markdown
  return adapters;
}
