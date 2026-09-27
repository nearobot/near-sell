import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { AppError, assert } from './core.ts';
import type { Mode } from './types.ts';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface Config {
  mode: Mode;
  pollIntervalMs: number;
  telegramToken?: string;
  fastnearApiKey?: string;
  vaultPassword?: string;
  rpcUrls?: string[];
}

// Read the same project-root .env for source and compiled entry points.
// Explicit process environment variables take precedence, including empty values.
export function loadConfig(root = projectRoot, environment: NodeJS.ProcessEnv = process.env, args: string[] = []): Config {
  let file: NodeJS.Dict<string> = {};
  try { file = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new AppError('Could not read the project .env file.', 'CONFIG');
    }
  }
  const values = { ...file, ...environment };
  const text = (key: string) => values[key]?.trim() || undefined;
  const mode = text('BOT_MODE') ?? 'paper';
  assert(mode === 'paper' || mode === 'live', 'BOT_MODE must be paper or live.', 'CONFIG');
  assert(!(args.includes('--live') && args.includes('--paper')), 'Choose either --live or --paper.', 'CONFIG');

  const interval = text('POLL_INTERVAL_MS') ?? '10000';
  const pollIntervalMs = Number(interval);
  assert(/^\d+$/.test(interval) && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 1000 && pollIntervalMs <= 300000,
    'POLL_INTERVAL_MS must be a whole number from 1000 to 300000.', 'CONFIG');

  const configuredUrls = text('NEAR_RPC_URLS');
  const rpcUrls = configuredUrls?.split(',').map(url => url.trim());
  if (rpcUrls) {
    assert(rpcUrls.length > 0 && rpcUrls.every(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
      catch { return false; }
    }), 'NEAR_RPC_URLS must contain comma-separated HTTPS RPC URLs without embedded credentials.', 'CONFIG');
  }

  return {
    mode: args.includes('--paper') ? 'paper' : args.includes('--live') ? 'live' : mode,
    pollIntervalMs, rpcUrls,
    telegramToken: text('TELEGRAM_BOT_TOKEN'),
    fastnearApiKey: text('FASTNEAR_API_KEY'),
    // Preserve spaces in a quoted passphrase; it must match the vault exactly.
    vaultPassword: values.VAULT_PASSWORD || undefined,
  };
}
