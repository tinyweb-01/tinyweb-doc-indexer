import type { Logger } from './types.js';

export class ConsoleLogger implements Logger {
  constructor(private readonly verbose = false) {}
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`[info] ${message}`, meta ?? '');
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[warn] ${message}`, meta ?? '');
  }
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[error] ${message}`, meta ?? '');
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.verbose) console.debug(`[debug] ${message}`, meta ?? '');
  }
}

export const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
