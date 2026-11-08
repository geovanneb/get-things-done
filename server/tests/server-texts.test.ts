import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { en } from '../src/i18n/en';

/**
 * The dashboard translates a fixed server message by its exact English text (`server.*` keys, see serverText). For
 * the share pack, Request changes and Waiting for, every such text must still be sent word for word, or the message
 * silently falls back to English.
 */
test('the share pack, Request changes and Waiting for still send the English texts the dashboard translates', () => {
  const source = ['services/sharePack.ts', 'services/taskService.ts']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf-8')).join('\n');
  const keys = Object.keys(en).filter((k) => /^server\.(share|cr|wait|taskChangedRetry|taskBusy)/.test(k));
  assert.ok(keys.length >= 25, `${keys.length} keys`);
  for (const key of keys) {
    const text = (en as Record<string, string>)[key]!;
    const quoted = [`'${text.replace(/'/g, "\\'")}'`, `"${text}"`];
    assert.ok(quoted.some((q) => source.includes(q)), `${key}: "${text}" is not sent by the server any more`);
  }
});
