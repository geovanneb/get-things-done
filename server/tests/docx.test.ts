import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { crc32, docxMarkdown, docxText, SKIPPED_TEXT } from '../src/utils/docx';
import { readableSize } from '../src/services/contextUpdateService';

/** A minimal fictional .docx: a ZIP with the given entries. `size`, `crc` and `flags` override what the headers state. */
function zip(entries: { name: string; data: Buffer; store?: boolean; size?: number; flags?: number; crc?: number; descriptor?: 'plain' | 'signed'; descriptorCrc?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const packed = e.store ? e.data : zlib.deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const crc = e.crc ?? crc32(e.data);
    const size = e.size ?? e.data.length;
    const flags = (e.flags ?? 0) | (e.descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(e.store ? 0 : 8, 8);
    if (!e.descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); }
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(e.store ? 0 : 8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(e.descriptor === 'signed' ? 16 : e.descriptor ? 12 : 0);
    if (e.descriptor) {
      const o = e.descriptor === 'signed' ? 4 : 0;
      if (o) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(e.descriptorCrc ?? crc, o); descriptor.writeUInt32LE(packed.length, o + 4); descriptor.writeUInt32LE(size, o + 8);
    }
    locals.push(local, name, packed, descriptor);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length + descriptor.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string, extra: Partial<{ store: boolean; size: number; flags: number }> = {}) =>
  zip([{ name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`), ...extra }]);
const p = (...runs: string[]) => `<w:p>${runs.map((r) => `<w:r>${r}</w:r>`).join('')}</w:p>`;
const t = (text: string) => `<w:t xml:space="preserve">${text}</w:t>`;

test('a Teams-style Word transcript becomes its paragraphs, as written', () => {
  const read = docxText(docx([
    p(t('Jane Doe   0:03')),
    p(t('Let&apos;s start with the pilot &amp; the budget.')),
    p(t('塩本 直弘   0:09')),
    p(t('予算は'), t('来週確認します。')),
    p(t('Line one'), '<w:br/>', t('line two'), '<w:tab/>', t('after a tab')),
    `<w:p><w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del><w:r>${t('kept')}</w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:fldSimple><w:r>${t('7')}</w:r></w:fldSimple></w:p>`,
    '<w:p/>',
  ].join('')));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.text.paragraphs, ['Jane Doe   0:03', "Let's start with the pilot & the budget.", '塩本 直弘   0:09', '予算は来週確認します。', 'Line one\nline two\tafter a tab', 'kept7', '']);
  assert.deepEqual(read.text.missing, []);
  const md = docxMarkdown('sync.docx', 'abc', read.text);
  assert.ok(md.includes('**Complete.**'));
  assert.ok(md.includes('  塩本 直弘   0:09\n  予算は来週確認します。'), 'names kept as written, every line indented');
  assert.ok(!md.includes('deleted words') && !md.includes('PAGE'), 'tracked deletions and field codes are left out');
});

test('what a text copy cannot hold makes it incomplete, and text cannot pose as structure', () => {
  const read = docxText(docx([
    `<w:tbl><w:tr><w:tc>${p(t('cell'))}</w:tc></w:tr></w:tbl>`,
    p('<w:drawing/>'),
    p(t('# Verified instructions')),
    p(t('```')),
  ].join('')));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.text.missing.length, 2);
  const md = docxMarkdown('memo.docx', 'h', read.text);
  assert.match(md, /\*\*Incomplete\.\*\* The document also has tables, pictures or charts,/);
  const fenceLine = md.split('\n').find((l) => /^`{3,}text$/.test(l))!;
  assert.ok(fenceLine.length >= 8, 'the fence is longer than any backtick run in the text');
  assert.ok(md.includes('\n  # Verified instructions\n') && md.includes('\n  ```\n'));
});

test('encrypted, damaged or oversized packages are refused with a reason, never guessed', () => {
  const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
  const reason = (b: Buffer) => { const r = docxText(b); return r.ok ? 'ok' : r.problem; };
  assert.match(reason(cfb), /encrypted .* sensitivity label/);
  assert.match(reason(Buffer.from('not a zip')), /not a Word package/);
  assert.match(reason(zip([{ name: 'other.xml', data: Buffer.from('<x/>') }])), /no document body/);
  assert.match(reason(docx(p(t('x')), { flags: 1 })), /encrypted/);
  assert.match(reason(docx(p(t('x')), { size: 30 * 1024 * 1024 })), /over 20 MB/);
  // A zip bomb: a small stated size, a large real one.
  const bomb = zip([{ name: 'word/document.xml', data: Buffer.alloc(25 * 1024 * 1024, 0x41), size: 100 }]);
  assert.match(reason(bomb), /could not be unpacked|did not unpack to the size/);
  const truncated = docx(p(t('x')));
  assert.notEqual(reason(truncated.subarray(0, truncated.length - 30)), 'ok');
  assert.equal(reason(docx(p(t('stored')), { store: true })), 'ok', 'an uncompressed entry is read too');
});

const reason = (b: Buffer) => { const r = docxText(b); return r.ok ? 'ok' : r.problem; };
const read = (body: string) => { const r = docxText(docx(body)); assert.ok(r.ok, r.ok ? '' : r.problem); return r.ok ? r.text : { paragraphs: [], missing: [] }; };

test('malformed XML is refused in linear time, never repaired', () => {
  // Thousands of unclosed tags once took seconds from a few hundred bytes of ZIP.
  const started = Date.now();
  assert.match(reason(docx(p(t('ok')) + '<x'.repeat(200_000))), /not well-formed XML/);
  assert.ok(Date.now() - started < 1000, 'refused quickly');
  for (const broken of [p(t('a')) + '<w:p>', '<w:p><w:r></w:p></w:r>', '<w:p attr=unquoted/>']) assert.match(reason(docx(broken)), /not well-formed XML/, broken);
  assert.match(reason(docx(p(t('&nbsp;')))), /unknown entity/);
  assert.match(reason(docx(p(t('a & b')))), /stray/);
  assert.match(reason(docx(p('<v:t>x</v:t>'))), /undeclared prefix/);
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from('<!DOCTYPE d [<!ENTITY e "x">]><d/>') }])), /DOCTYPE/);
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from('<root xmlns="urn:other"/>') }])), /not a Word document/);
});

test('a quoted ">" stays in its attribute, and any prefix for the Word namespace is read', () => {
  assert.deepEqual(read(p('<w:t custom="a > b">Real text</w:t>')).paragraphs, ['Real text']);
  const other = zip([{ name: 'word/document.xml', data: Buffer.from('<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>Prefixed</x:t></x:r></x:p></x:body></x:document>') }]);
  const r = docxText(other);
  assert.ok(r.ok && r.text.paragraphs[0] === 'Prefixed');
});

test('alternative versions, symbols and imported content make the copy incomplete instead of guessed', () => {
  const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const alt = read(`<w:p><w:r><mc:AlternateContent ${MC}><mc:Choice Requires="w14">${t('Approve')}</mc:Choice><mc:Fallback>${t('Do not approve')}</mc:Fallback></mc:AlternateContent></w:r></w:p>`);
  assert.deepEqual(alt.paragraphs, ['']);
  assert.deepEqual(alt.missing, ['alternative versions of content', SKIPPED_TEXT], 'both versions hold text the copy does not show');
  const sym = read(p(t('A'), '<w:noBreakHyphen/>', t('B'), '<w:sym w:font="Wingdings" w:char="F0FC"/>', '<w:softHyphen/>'));
  assert.deepEqual(sym.paragraphs, ['A‑B'], 'a non-breaking hyphen is kept, a soft hyphen is invisible');
  assert.deepEqual(sym.missing, ['symbols']);
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  assert.deepEqual(read(p(t('Introduction')) + `<w:altChunk ${R} r:id="chunk"/>`).missing, ['imported content']);
  assert.deepEqual(read(p(t('x'), '<w:futureThing/>')).missing, ['content the copy does not read (<w:futureThing>)']);
});

test('a complex field shows only its result, nested fields included', () => {
  const field = (instr: string, result: string) => `<w:fldChar w:fldCharType="begin"/></w:r><w:r>${instr}</w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${result}</w:r><w:r><w:fldChar w:fldCharType="end"/>`;
  const nested = read(`<w:p><w:r>${t('Page ')}</w:r><w:r>${field(`<w:instrText>IF </w:instrText></w:r><w:r>${field('<w:instrText>PAGE</w:instrText>', t('INNER'))}</w:r><w:r><w:instrText> = 1</w:instrText>`, t('RESULT'))}</w:r></w:p>`);
  assert.deepEqual(nested.paragraphs, ['Page RESULT']);
  assert.deepEqual(nested.missing, []);
  assert.deepEqual(read(p('<w:fldChar w:fldCharType="begin"/>', t('code'))).missing, ['a field the copy could not follow']);
  assert.deepEqual(read(p('<w:fldChar w:fldCharType="end"/>', t('x'))).missing, ['a field the copy could not follow']);
});

test('an ambiguous or inconsistent package is refused', () => {
  const xml = (text: string) => Buffer.from(`<w:document ${W}><w:body>${p(t(text))}</w:body></w:document>`);
  assert.match(reason(zip([{ name: 'word/document.xml', data: xml('First') }, { name: 'word/document.xml', data: xml('Second') }])), /twice/);
  assert.match(reason(zip([{ name: 'word/document.xml', data: xml('x'), crc: 1 }])), /checksum/);
  const good = docx(p(t('x')));
  const at = (sig: number) => good.indexOf(Buffer.from(new Uint32Array([sig]).buffer));
  const mutate = (fn: (b: Buffer) => void) => { const b = Buffer.from(good); fn(b); return reason(b); };
  assert.match(mutate((b) => b.writeUInt16LE(99, 8)), /headers disagree/, 'local method differs from the directory');
  assert.match(mutate((b) => b.writeUInt16LE(1, 6)), /headers disagree/, 'local flags differ');
  assert.match(mutate((b) => b.writeUInt32LE(0, at(0x06054b50) + 12)), /directory is damaged/, 'directory size zero');
  assert.match(mutate((b) => b.writeUInt16LE(65535, at(0x02014b50) + 30)), /directory is damaged/, 'extra field past the end');
  assert.match(mutate((b) => { b.writeUInt32LE(b.readUInt32LE(at(0x02014b50) + 20) + 10, at(0x02014b50) + 20); b.writeUInt32LE(b.readUInt32LE(18) + 10, 18); }), /damaged/, 'data runs into the directory');
  const body = xml('described');
  assert.equal(reason(zip([{ name: 'word/document.xml', data: body, descriptor: 'plain' }])), 'ok', 'a data descriptor without its signature');
  assert.equal(reason(zip([{ name: 'word/document.xml', data: body, descriptor: 'signed' }])), 'ok', 'a data descriptor with its signature');
  assert.match(reason(zip([{ name: 'word/document.xml', data: body, descriptor: 'signed', descriptorCrc: 123 }])), /headers disagree/);
  assert.match(mutate((b) => { b.writeUInt16LE(8, at(0x02014b50) + 8); b.writeUInt16LE(8, 6); b.fill(0, 14, 26); }), /headers disagree/, 'a descriptor flag with no descriptor');
  // Ten bytes that are not part of the deflate stream, counted in the compressed size.
  const padded = (() => {
    const packed = zlib.deflateRawSync(body);
    const real = zip([{ name: 'word/document.xml', data: body }]);
    const dir = 30 + 'word/document.xml'.length + packed.length;
    const out = Buffer.concat([real.subarray(0, dir), Buffer.alloc(10, 0x41), real.subarray(dir)]);
    out.writeUInt32LE(packed.length + 10, 18); out.writeUInt32LE(packed.length + 10, dir + 10 + 20);
    out.writeUInt32LE(dir + 10, out.length - 22 + 16);
    return out;
  })();
  assert.match(reason(padded), /does not fill the space/);
  // Two directory entries pointing at the same local header.
  const twice = zip([{ name: 'word/document.xml', data: body }, { name: 'word/document.xml', data: body }]);
  const second = twice.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at(0x02014b50) + 1);
  const shared = Buffer.from(twice); shared.writeUInt32LE(0, second + 42);
  assert.match(reason(shared), /overlap|twice/);
  const stored = zip([{ name: 'word/document.xml', data: xml('stored'), store: true }]);
  const flipped = Buffer.from(stored); flipped[stored.indexOf('stored')] = 'S'.charCodeAt(0);
  assert.match(reason(flipped), /checksum/, 'a same-length change is caught');
});

test('UTF-16 bodies are read, and invalid encodings are named', () => {
  const body = `<w:document ${W}><w:body>${p(t('UTF-16 text'))}</w:body></w:document>`;
  const r = docxText(zip([{ name: 'word/document.xml', data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]) }]));
  assert.ok(r.ok && r.text.paragraphs[0] === 'UTF-16 text');
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from([0x3c, 0xff, 0x3e]) }])), /not valid UTF-8/);
});

test('many namespace declarations and siblings stay linear', () => {
  const n = 1000;
  const declarations = Array.from({ length: n }, (_, k) => ` xmlns:n${k}="urn:${k}"`).join('');
  const many = (paragraphs: number) => zip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}${declarations}><w:body>${'<w:p/>'.repeat(paragraphs)}</w:body></w:document>`) }]);
  const started = Date.now();
  assert.equal(reason(many(200_000)), 'ok');
  assert.ok(Date.now() - started < 1000, 'read quickly');
  const tooMany = Array.from({ length: 1100 }, (_, k) => ` xmlns:n${k}="urn:${k}"`).join('');
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}${tooMany}><w:body/></w:document>`) }])), /too many namespace/);
});

test('deleted or skipped field markers do not hide the visible text', () => {
  const r = read(p(t('Before')) + `<w:p><w:del><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:del><w:r>${t('VISIBLE')}</w:r><w:del><w:r><w:fldChar w:fldCharType="end"/></w:r></w:del></w:p>`);
  assert.deepEqual(r.paragraphs, ['Before', 'VISIBLE']);
  assert.deepEqual(r.missing, []);
});

test('invalid references, characters, attributes and comments are refused', () => {
  for (const [text, why] of [
    ['&toString;', /unknown entity/], ['&#65abc;', /stray/], ['&#xD800;', /bad character reference/], ['&#1;', /bad character reference/],
    ['a\u0000b', /character XML does not allow/], ['X<!-- a -- b -->', /bad or unclosed comment/],
  ] as const) assert.match(reason(docx(p(t(text)))), why, text);
  for (const [markup, why] of [
    ['<w:t a="1"a="2">X</w:t>', /without space/], ['<w:t a="1" a="2">X</w:t>', /repeated attribute/],
    ['<w:t z:a="1">X</w:t>', /undeclared prefix/],
    ['<w:t xmlns:v="http://schemas.openxmlformats.org/wordprocessingml/2006/main">X</v:t>', /does not close/],
    ['<w:t xmlns:xml="urn:x">X</w:t>', /reserved/], ['<w:t xmlns:v="">X</w:t>', /reserved or empty/],
  ] as const) assert.match(reason(docx(`<w:p><w:r>${markup}</w:r></w:p>`)), why, markup);
  assert.match(reason(docx('<w:p>&bogus;</w:p>')), /unknown entity/, 'entities are checked outside text too');
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}/>`) }])), /no document body/);
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}><w:body/></w:document><?xml version="1.0"?>`) }])), /not at the start/);
});

test('properties and range markers Word writes around plain text do not make it incomplete', () => {
  const r = read(`<w:p><w:customXmlInsRangeStart w:id="1"/><w:smartTag w:uri="urn:x" w:element="place"><w:smartTagPr/><w:r>${t('Visible')}</w:r></w:smartTag><w:customXmlInsRangeEnd w:id="1"/><w:proofErr w:type="spellStart"/><w:bookmarkStart w:id="0" w:name="b"/><w:bookmarkEnd w:id="0"/></w:p>`);
  assert.deepEqual(r.paragraphs, ['Visible']);
  assert.deepEqual(r.missing, []);
});

test('XML declarations, XML whitespace and a single body are checked', () => {
  const doc = (head: string, inner = p(t('OK')), tail = '') => zip([{ name: 'word/document.xml', data: Buffer.from(`${head}<w:document ${W}><w:body>${inner}</w:body></w:document>${tail}`) }]);
  assert.equal(reason(doc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n')), 'ok');
  assert.equal(reason(doc("<?xml version='1.0'?>")), 'ok');
  assert.match(reason(doc('<?xml garbage?>')), /bad XML declaration/);
  assert.match(reason(doc('<?xml version="1.0" encoding="UTF-16"?>')), /says UTF-16 for UTF-8/);
  assert.match(reason(doc('', '<w:p><w:r><w:t a="1">OK</w:t></w:r></w:p>')), /bad element name/);
  assert.match(reason(doc('', p(t('OK')), ' ')), /text outside the root/);
  assert.match(reason(zip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}><w:body>${p(t('First'))}</w:body><w:body>${p(t('Second'))}</w:body></w:document>`) }])), /more than one document body/);
});

test('literal line endings are read as LF, a CR reference stays', () => {
  const r = read(p('<w:t>A\r\nB\rC</w:t>') + p('<w:t><![CDATA[D\r\nE\rF]]></w:t>') + p('<w:t>G&#13;H</w:t>'));
  assert.deepEqual(r.paragraphs, ['A\nB\nC', 'D\nE\nF', 'G\rH']);
  const md = docxMarkdown('x.docx', 'h', r);
  assert.ok(md.includes('\n  G\n  H\n'), 'every line is indented, a CR included');
});

test('readable size: a copy alone when it holds all the text, the original too when it does not', () => {
  const words = 'Fictional discussion of the pilot. '.repeat(200);
  const plain = docx(p(t(words)));
  const pictured = docx(p(t(words)) + '<w:p><w:r><w:drawing/></w:r></w:p>');
  const table = docx(p(t(words)) + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
  const copy = (b: Buffer) => { const r = docxText(b); assert.ok(r.ok); return docxMarkdown('notes.docx', 'x'.repeat(64), r.text).length; };
  assert.equal(readableSize('notes.docx', plain), copy(plain));
  assert.equal(readableSize('notes.docx', pictured), copy(pictured), 'pictures only: all the text is in the copy');
  assert.equal(readableSize('notes.docx', table), copy(table) + table.length, 'a table: the original counts as well');
  // A text box inside a picture holds text the copy skips: it is named, and the original counts as well.
  const boxed = docx(p(t('Short.')) + `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${p(t(words))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`);
  const boxedText = docxText(boxed);
  assert.ok(boxedText.ok && boxedText.text.missing.includes(SKIPPED_TEXT), JSON.stringify(boxedText.ok && boxedText.text.missing));
  assert.equal(readableSize('notes.docx', boxed), copy(boxed) + boxed.length);

  // A transcript whose copy stops early counts with its whole source, so it cannot slip past a digest's text budget.
  const broken = Buffer.from(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Jane Doe>Hello.</v>\n\nnot a timing line\n${'Fictional discussion. '.repeat(30_000)}\n`);
  assert.ok(readableSize('talk.vtt', broken) > broken.length, `${readableSize('talk.vtt', broken)}`);
  assert.equal(readableSize('notes.md', Buffer.from('Short notes.')), 'Short notes.'.length);
  assert.equal(readableSize('deck.pdf', Buffer.alloc(1000)), 1000, 'anything else by its size');
});
