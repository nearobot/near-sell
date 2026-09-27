import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.ts';

function withEnv(contents: string | undefined, check: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'near-bot-env-'));
  const file = path.join(root, '.env');
  try {
    if (contents !== undefined) fs.writeFileSync(file, contents);
    check(root);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}

test('missing env preserves paper mode, public RPC defaults and hidden password prompt', () => {
  withEnv(undefined, root => {
    const config = loadConfig(root, {});
    assert.equal(config.mode, 'paper'); assert.equal(config.pollIntervalMs, 10000);
    assert.equal(config.vaultPassword, undefined); assert.equal(config.telegramToken, undefined);
    assert.equal(config.rpcUrls, undefined); assert.equal(config.fastnearApiKey, undefined);
  });
  assert.equal(projectRoot, path.resolve(import.meta.dirname, '..'));
});

test('project env handles quoted secrets and process environment takes precedence', () => {
  withEnv('BOT_MODE=live\nPOLL_INTERVAL_MS=15000\nTELEGRAM_BOT_TOKEN=synthetic-token\nFASTNEAR_API_KEY=synthetic-key\nVAULT_PASSWORD=" passphrase with # and spaces "\nNEAR_RPC_URLS=https://example.org/one, https://example.org/two\n', root => {
    const config = loadConfig(root, { BOT_MODE: 'paper', POLL_INTERVAL_MS: '25000', TELEGRAM_BOT_TOKEN: '' });
    assert.equal(config.mode, 'paper'); assert.equal(config.pollIntervalMs, 25000);
    assert.equal(config.telegramToken, undefined); assert.equal(config.fastnearApiKey, 'synthetic-key');
    assert.equal(config.vaultPassword, ' passphrase with # and spaces ');
    assert.deepEqual(config.rpcUrls, ['https://example.org/one', 'https://example.org/two']);
  });
});

test('explicit paper prevents live env execution; live override is explicit and conflicting flags fail', () => {
  withEnv('BOT_MODE=live', root => {
    assert.equal(loadConfig(root, {}).mode, 'live');
    assert.equal(loadConfig(root, {}, ['--paper']).mode, 'paper');
    assert.equal(loadConfig(root, { BOT_MODE: 'paper' }, ['--live']).mode, 'live');
    assert.throws(() => loadConfig(root, {}, ['--paper', '--live']), /either/);
    assert.throws(() => loadConfig(root, { BOT_MODE: 'liv' }), /BOT_MODE/);
  });
});

test('invalid intervals and RPC URLs stop startup without exposing their contents', () => {
  withEnv('', root => {
    for (const value of ['0', '-1', '999', '300001', '1.5', '1e4', 'Infinity', 'invalid']) {
      assert.throws(() => loadConfig(root, { POLL_INTERVAL_MS: value }), /POLL_INTERVAL_MS/);
    }
    for (const value of ['synthetic-secret', 'http://example.org', 'https://user:synthetic-secret@example.org', 'https://example.org,']) {
      assert.throws(() => loadConfig(root, { NEAR_RPC_URLS: value }), error => {
        assert.ok(error instanceof Error); assert.match(error.message, /NEAR_RPC_URLS/);
        assert.equal(error.message.includes('synthetic-secret'), false); return true;
      });
    }
  });
});

test('env parsing does not modify the process environment or the env file', () => {
  const previous = process.env.BOT_MODE;
  const contents = 'BOT_MODE=live\nVAULT_PASSWORD="synthetic passphrase"\n';
  withEnv(contents, root => {
    loadConfig(root, {});
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), contents);
    assert.equal(process.env.BOT_MODE, previous);
  });
});
