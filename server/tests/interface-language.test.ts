import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectLocale, isPreference, languages, type Locale } from '../src/i18n/locale';
import { en } from '../src/i18n/en';
import { loadCatalog, plural, translator } from '../src/i18n/messages';
import { readUserConfig, updateUserConfig } from '../src/services/userConfig';

test('language matching respects priority, regional fallbacks and invalid tags', () => {
  assert.equal(detectLocale(['de-DE', 'ja-JP', 'en-US']), 'ja');
  assert.equal(detectLocale(['pt-PT', 'ja']), 'pt-BR');
  assert.equal(detectLocale(['es-MX']), 'es-419');
  assert.equal(detectLocale(['PT-br']), 'pt-BR');
  assert.equal(detectLocale(['', 'bad_tag', 'fr', 'en-GB']), 'en');
  assert.equal(detectLocale([]), 'en');
  for (const invalid of [null, {}, 'constructor', '__proto__', 'fr', 'ja-JP']) assert.equal(isPreference(invalid), false);
  assert.equal(isPreference('auto'), true);
});

test('all catalogs have matching keys and placeholders; interpolation treats content as data', async () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const locale of Object.keys(languages) as Locale[]) {
    const catalog = await loadCatalog(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const message = catalog[key];
      const source = en[key];
      const sourceText = typeof source === 'string' ? source : source.other;
      for (const text of typeof message === 'string' ? [message] : Object.values(message)) {
        assert.ok(text.trim());
        assert.deepEqual(placeholders(text), placeholders(sourceText), `${locale}: ${key}`);
      }
    }
    assert.equal(translator(catalog, locale)('validationErrors', { count: 2 }), plural(locale, 2, catalog.validationErrors));
    assert.ok(translator(catalog)('automatic', { language: '<日本語>' }).includes('<日本語>'));
    assert.ok(translator(catalog, locale)('gitButton', { count: 2, branch: 'main' }).includes('main'));
  }
  assert.equal(translator({ ...en, language: '' })('language'), 'Language');
});

test('plural forms use locale rules, including Japanese and Portuguese zero', () => {
  const forms = { one: '{count} item', other: '{count} items' };
  assert.equal(plural('en', 0, forms), '0 items');
  assert.equal(plural('pt-BR', 0, forms), '0 item');
  assert.equal(plural('ja', 1, forms), '1 items');
});

test('concurrent personal config updates preserve unknown fields and each writer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-language-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, JSON.stringify({ unknown: { keep: true }, port: 3210 }));
    await Promise.all([
      updateUserConfig(current => ({ ...current, interface_language: 'ja' }), file),
      updateUserConfig(current => ({ ...current, workspace_path: '/fictional/north' }), file),
      updateUserConfig(current => ({ ...current, recent_workspaces: [{ path: '/fictional/south', last_opened: '2026-01-01' }] }), file),
    ]);
    assert.deepEqual(readUserConfig(file), { unknown: { keep: true }, port: 3210, interface_language: 'ja', workspace_path: '/fictional/north', recent_workspaces: [{ path: '/fictional/south', last_opened: '2026-01-01' }] });
    await updateUserConfig(current => ({ ...current, interface_language: 'auto' }), file);
    assert.equal(readUserConfig(file).interface_language, 'auto');
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
    for (const damaged of ['{', 'null', '[]']) {
      await fs.writeFile(file, damaged);
      await assert.rejects(updateUserConfig(current => ({ ...current, interface_language: 'en' }), file));
      assert.equal(await fs.readFile(file, 'utf8'), damaged);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
