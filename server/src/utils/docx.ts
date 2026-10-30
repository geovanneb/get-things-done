import * as zlib from 'zlib';

/**
 * The text of a Word document (.docx), paragraph by paragraph, for a readable copy next to it: Teams can export a
 * meeting transcript as one. Only the main body is read (`word/document.xml`), with strict limits, from a validated
 * ZIP package; nothing is decrypted, run or followed. Speaker names are not parsed out: the text stays as written.
 *
 * Nothing is assumed. The XML must be well formed (one linear pass, quote-aware, namespaces declared, no DOCTYPE).
 * Only a fixed set of WordprocessingML elements becomes text: paragraphs, runs, text, tabs, breaks, hyphens, links,
 * content controls, tracked insertions and the displayed result of fields. Anything else that can carry content
 * (alternative content, symbols, imported chunks, tables, pictures, objects, text boxes, unknown elements) makes the
 * copy incomplete and is named, so the original is read as well. Tracked deletions and field instructions are left
 * out on purpose: they are not what the document shows.
 */

/** Unpacked size of the document body that is read at most. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 256;

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_DESCRIPTOR = 0x08074b50;
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_XML = 'http://www.w3.org/XML/1998/namespace';

export interface DocxText {
  paragraphs: string[];
  /** What the text copy cannot hold, in plain words. Empty when the body is fully read as text. */
  missing: string[];
}

export type DocxResult = { ok: true; text: DocxText } | { ok: false; problem: string };

let CRC_TABLE: Uint32Array | null = null;

/** CRC-32 as ZIP uses it. */
export function crc32(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One file from a ZIP package, unpacked within `max` bytes and checked against its CRC-32, or a reason it cannot be
 * read. The whole package is validated: the directory and every entry's local header, data and data descriptor
 * inside the file, before the directory and not overlapping; local and central headers agreeing; the target present
 * exactly once, and its compressed data used to the last byte.
 */
function zipEntry(buffer: Buffer, name: string, max: number): Buffer | string {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === ZIP_END && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) return 'it is not a complete Word package';
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) return 'it is split over several files';
  const count = buffer.readUInt16LE(end + 10);
  const dirSize = buffer.readUInt32LE(end + 12);
  const dirStart = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || dirStart === 0xffffffff || dirSize === 0xffffffff) return 'it uses a ZIP64 package, which is not read here';
  if (count !== buffer.readUInt16LE(end + 8) || dirStart + dirSize !== end) return 'its package directory is damaged';

  let at = dirStart;
  let found: { flags: number; method: number; crc: number; packed: number; size: number; data: number } | null = null;
  const ranges: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== ZIP_CENTRAL) return 'its package directory is damaged';
    const nameLength = buffer.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    if (next > end || buffer.readUInt16LE(at + 34) !== 0) return 'its package directory is damaged';
    const entryName = buffer.toString('latin1', at + 46, at + 46 + nameLength);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const local = buffer.readUInt32LE(at + 42);
    at = next;

    // The entry's local header, data and data descriptor, all before the directory.
    if (local + 30 > dirStart || buffer.readUInt32LE(local) !== ZIP_LOCAL) return 'its package is damaged';
    const localNameLength = buffer.readUInt16LE(local + 26);
    const data = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method
      || local + 30 + localNameLength > dirStart || buffer.toString('latin1', local + 30, local + 30 + localNameLength) !== entryName) return 'its package headers disagree';
    let stop = data + packed;
    if (flags & 0x8) {
      // A data descriptor follows the data, with or without its signature, and must state what the directory states.
      const states = (o: number) => o + 12 <= dirStart && buffer.readUInt32LE(o) === crc && buffer.readUInt32LE(o + 4) === packed && buffer.readUInt32LE(o + 8) === size;
      if (stop + 16 <= dirStart && buffer.readUInt32LE(stop) === ZIP_DESCRIPTOR && states(stop + 4)) stop += 16;
      else if (states(stop)) stop += 12;
      else return 'its package headers disagree';
    } else if (buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== packed || buffer.readUInt32LE(local + 22) !== size) {
      return 'its package headers disagree';
    }
    if (stop > dirStart) return 'its package is damaged';
    ranges.push([local, stop]);
    if (entryName === name) {
      if (found) return `it holds ${name} twice`;
      found = { flags, method, crc, packed, size, data };
    }
  }
  if (at !== end) return 'its package directory is damaged';
  ranges.sort((a, b) => a[0] - b[0]);
  for (let n = 1; n < ranges.length; n++) if (ranges[n]![0] < ranges[n - 1]![1]) return 'its package entries overlap';
  if (!found) return 'it has no document body (word/document.xml)';
  if (found.flags & 0x41) return 'its text is encrypted';
  if (found.size > max) return `its text is over ${Math.round(max / 1024 / 1024)} MB unpacked`;
  if (found.method !== 0 && found.method !== 8) return 'its package uses a compression that is not read here';

  const data = buffer.subarray(found.data, found.data + found.packed);
  let out: Buffer;
  if (found.method === 0) out = data;
  else {
    try {
      const inflated = zlib.inflateRawSync(data, { maxOutputLength: max, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.engine.bytesWritten !== data.length) return 'its text does not fill the space the package states';
      out = inflated.buffer;
    } catch { return 'its text could not be unpacked'; }
  }
  if (out.length !== found.size) return 'its text did not unpack to the size the package states';
  if (crc32(out) !== found.crc) return 'its text does not match its checksum';
  return out;
}

const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
const NS_XMLNS = 'http://www.w3.org/2000/xmlns/';
/** Namespace declarations accepted in one document: Word writes a few dozen. */
const MAX_DECLARATIONS = 1024;

/** A character XML allows. */
function xmlChar(n: number): boolean {
  return n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}

/** Decodes the five XML entities and character references; anything else makes the document malformed. */
function decodeXml(text: string): string {
  return text.replace(/&(?:(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_][\w.-]*);)?/g, (whole, code: string | undefined) => {
    if (code === undefined) throw new Error('a stray "&"');
    if (code[0] === '#') {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!xmlChar(n)) throw new Error(`a bad character reference ${whole}`);
      return String.fromCodePoint(n);
    }
    const value = ENTITIES.get(code);
    if (value === undefined) throw new Error(`an unknown entity ${whole}`);
    return value;
  });
}

/** Elements that only carry layout or bookkeeping: they and everything inside are skipped. */
const IGNORED = new Set([
  'pPr', 'rPr', 'sectPr', 'sdtPr', 'sdtEndPr', 'proofErr', 'bookmarkStart', 'bookmarkEnd', 'permStart', 'permEnd',
  'commentRangeStart', 'commentRangeEnd', 'commentReference', 'lastRenderedPageBreak', 'softHyphen', 'rPrChange',
  'pPrChange', 'customXmlPr', 'smartTagPr', 'annotationRef', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart',
  'moveToRangeEnd', 'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
  'customXmlMoveFromRangeStart', 'customXmlMoveFromRangeEnd', 'customXmlMoveToRangeStart', 'customXmlMoveToRangeEnd',
  'tblPr', 'tblGrid', 'tblPrEx', 'trPr', 'tcPr', 'noProof',
]);
/** Elements that are left out on purpose: they and everything inside are not what the document shows. */
const HIDDEN = new Set(['del', 'moveFrom', 'instrText', 'delInstrText']);
/** Elements that only group content that is read: they are passed through. */
const WRAPPERS = new Set(['document', 'body', 'r', 'hyperlink', 'smartTag', 'sdt', 'sdtContent', 'ins', 'moveTo', 'customXml', 'fldSimple', 'dir', 'bdo', 'tr', 'tc']);
/** What a text copy cannot hold, by element, in plain words. */
const NOT_TEXT = new Map([
  ['tbl', 'tables'], ['drawing', 'pictures or charts'], ['pict', 'pictures or charts'], ['object', 'embedded objects'],
  ['txbxContent', 'text boxes'], ['sym', 'symbols'], ['altChunk', 'imported content'], ['AlternateContent', 'alternative versions of content'],
  ['footnoteReference', 'footnote references'], ['endnoteReference', 'endnote references'], ['ptab', 'positioned tabs'],
]);

const NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;
/** XML whitespace, after line endings are read as LF: not every character JavaScript calls space. */
const SPACE = /^[ \t\n]$/;
const XML_DECLARATION = /^<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(["'])1\.[0-9]+\1(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(["'])([A-Za-z][\w.-]*)\2)?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(["'])(?:yes|no)\4)?[ \t\n]*\?>$/;

interface Open { qname: string; name: string; ns: Map<string, string>; suppress: boolean; paragraph: boolean }

/** The body text of a Word document. */
export function docxText(buffer: Buffer): DocxResult {
  if (buffer.subarray(0, 8).equals(CFB_SIGNATURE)) {
    return { ok: false, problem: 'The Word file is encrypted (for example by a sensitivity label or a password) or in the old .doc format, so it cannot be read. Export the transcript as .vtt or .txt, or save a copy without the label.' };
  }
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL) return { ok: false, problem: 'The file is not a Word package (.docx), so no readable copy was made.' };
  const body = zipEntry(buffer, 'word/document.xml', MAX_BODY_BYTES);
  if (typeof body === 'string') return { ok: false, problem: `No readable copy was made: ${body}.` };
  let xml: string;
  const encoding = body[0] === 0xff && body[1] === 0xfe ? 'utf-16le' : body[0] === 0xfe && body[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    xml = new TextDecoder(encoding, { fatal: true }).decode(encoding === 'utf-8' ? body : body.subarray(2));
  } catch {
    return { ok: false, problem: 'No readable copy was made: its text is not valid UTF-8 or UTF-16.' };
  }
  try {
    // XML reads every literal CRLF or CR as LF; a character reference such as &#13; is decoded later and stays.
    return { ok: true, text: readBody((xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml).replace(/\r\n?/g, '\n'), encoding) };
  } catch (err) {
    return { ok: false, problem: `No readable copy was made: the document body is not well-formed XML (${(err as Error).message}).` };
  }
}

/** One linear pass over the XML: quote-aware tags, matched elements, declared namespaces. Throws when malformed. */
function readBody(xml: string, encoding: string): DocxText {
  for (let k = 0; k < xml.length; k++) {
    const c = xml.charCodeAt(k);
    if ((c < 0x20 && c !== 0x9 && c !== 0xa && c !== 0xd) || c === 0xfffe || c === 0xffff) throw new Error('a character XML does not allow');
  }
  const paragraphs: string[] = [];
  const missing = new Set<string>();
  const stack: Open[] = [];
  // Open paragraphs: a text box can hold paragraphs inside a paragraph.
  const texts: string[] = [];
  // Complex fields: each is in its instruction part until "separate", then shows its result until "end".
  const fields: ('instruction' | 'result')[] = [];
  let instructions = 0;
  // Open elements whose content is skipped or hidden.
  let suppressed = 0;
  let declarations = 0;
  let sawRoot = false;
  let sawBody = false;
  let i = 0;
  const append = (text: string) => {
    if (texts.length && !suppressed && !instructions) texts[texts.length - 1] += text;
  };
  const note = (local: string, qname: string) => {
    if (!suppressed) missing.add(NOT_TEXT.get(local) ?? `content the copy does not read (<${qname}>)`);
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd);
      if (raw.includes(']]>')) throw new Error('"]]>" outside CDATA');
      const top = stack[stack.length - 1];
      if (!top) {
        if (/[^ \t\n]/.test(raw)) throw new Error('text outside the root element');
      } else {
        const text = decodeXml(raw);
        if (top.name === `${NS_W}|t`) append(text);
      }
      i = textEnd;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const close = xml.indexOf('--', i + 4);
      if (close < 0 || !xml.startsWith('-->', close)) throw new Error('a bad or unclosed comment');
      i = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const close = xml.indexOf(']]>', i + 9);
      if (close < 0) throw new Error('an unclosed CDATA section');
      const top = stack[stack.length - 1];
      if (!top) throw new Error('CDATA outside the root element');
      if (top.name === `${NS_W}|t`) append(xml.slice(i + 9, close));
      i = close + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const close = xml.indexOf('?>', i + 2);
      if (close < 0) throw new Error('an unclosed processing instruction');
      const target = /^[A-Za-z_][\w.:-]*/.exec(xml.slice(i + 2, Math.min(close, i + 2 + 256)))?.[0];
      if (!target || !/^[? \t\n]/.test(xml.slice(i + 2 + target.length, close + 1))) throw new Error('a bad processing instruction');
      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || i !== 0) throw new Error('an XML declaration that is not at the start');
        const declaration = XML_DECLARATION.exec(xml.slice(0, close + 2));
        if (!declaration) throw new Error('a bad XML declaration');
        const declared = declaration[3]?.toLowerCase();
        if (declared && declared !== (encoding === 'utf-8' ? 'utf-8' : 'utf-16') && declared !== encoding) {
          throw new Error(`an XML declaration that says ${declaration[3]} for ${encoding.toUpperCase()} text`);
        }
      }
      i = close + 2;
      continue;
    }
    if (xml.startsWith('<!', i)) throw new Error('a DOCTYPE or declaration, which is not accepted');

    // A tag: scan the name, then attributes, honouring quotes, up to ">" or "/>".
    const closing = xml[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < xml.length && /[^ \t\n/>=]/.test(xml[j]!)) j++;
    const qname = xml.slice(nameStart, j);
    if (!NAME.test(qname)) throw new Error(`a bad element name near character ${i}`);
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      const spaced = j < xml.length && SPACE.test(xml[j]!);
      while (j < xml.length && SPACE.test(xml[j]!)) j++;
      if (j >= xml.length) throw new Error('an unclosed tag');
      if (xml[j] === '>') { j++; break; }
      if (xml[j] === '/' && xml[j + 1] === '>' && !closing) { selfClosing = true; j += 2; break; }
      if (closing) throw new Error(`a closing tag with attributes </${qname}>`);
      if (!spaced) throw new Error(`attributes without space between them in <${qname}>`);
      const attrStart = j;
      while (j < xml.length && /[^ \t\n=/>]/.test(xml[j]!)) j++;
      const attr = xml.slice(attrStart, j);
      while (j < xml.length && SPACE.test(xml[j]!)) j++;
      if (!NAME.test(attr) || xml[j] !== '=') throw new Error(`a bad attribute in <${qname}>`);
      j++;
      while (j < xml.length && SPACE.test(xml[j]!)) j++;
      const quote = xml[j];
      if (quote !== '"' && quote !== "'") throw new Error(`an unquoted attribute in <${qname}>`);
      const close = xml.indexOf(quote, j + 1);
      if (close < 0) throw new Error('an unclosed attribute value');
      const value = xml.slice(j + 1, close);
      if (value.includes('<')) throw new Error('"<" in an attribute value');
      attrs.push([attr, decodeXml(value)]);
      j = close + 1;
    }
    i = j;

    if (closing) {
      const open = stack.pop();
      if (!open || open.qname !== qname) throw new Error(`</${qname}> does not close the open element`);
      if (open.suppress) suppressed--;
      if (open.paragraph) paragraphs.push(texts.pop()!);
      continue;
    }

    // Namespaces declared on this element apply to it and its content. Elements without declarations share their
    // parent's map, and declarations are limited, so this stays linear.
    const inherited = stack.length ? stack[stack.length - 1]!.ns : new Map([['xml', NS_XML]]);
    let ns = inherited;
    const seen = new Set<string>();
    for (const [attr, value] of attrs) {
      if (seen.has(attr)) throw new Error(`a repeated attribute ${attr} in <${qname}>`);
      seen.add(attr);
      if (attr !== 'xmlns' && !attr.startsWith('xmlns:')) continue;
      const prefix = attr === 'xmlns' ? '' : attr.slice(6);
      if (prefix === 'xmlns' || (prefix === 'xml') !== (value === NS_XML) || value === NS_XMLNS || (prefix && !value)) {
        throw new Error(`a reserved or empty namespace binding ${attr}`);
      }
      if (++declarations > MAX_DECLARATIONS) throw new Error('too many namespace declarations');
      if (ns === inherited) ns = new Map(inherited);
      ns.set(prefix, value);
    }
    const name = resolve(qname, ns);
    const expanded = new Set<string>();
    const values = new Map<string, string>();
    for (const [attr, value] of attrs) {
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) continue;
      const full = resolve(attr, ns, true);
      if (expanded.has(full)) throw new Error(`a repeated attribute ${attr} in <${qname}>`);
      expanded.add(full);
      values.set(full, value);
    }
    if (!sawRoot) {
      if (name !== `${NS_W}|document`) throw new Error('the root element is not a Word document');
      sawRoot = true;
    } else if (!stack.length) throw new Error('more than one root element');
    if (stack.length >= MAX_DEPTH) throw new Error('elements nested too deep');
    if (name === `${NS_W}|body` && stack.length === 1) {
      if (sawBody) throw new Error('more than one document body');
      sawBody = true;
    }

    const [uri, local] = name.split('|') as [string, string];
    const open: Open = { qname, name, ns, suppress: false, paragraph: false };
    if (uri !== NS_W) {
      // Another vocabulary, for example mc:AlternateContent or a drawing: its content is not read as text.
      note(local, qname);
      open.suppress = true;
    } else if (HIDDEN.has(local) || IGNORED.has(local)) {
      open.suppress = true;
    } else if (local === 'p') {
      open.paragraph = true;
      texts.push('');
    } else if (local === 't') {
      // Read where it stands.
    } else if (local === 'tab') {
      append('\t');
    } else if (local === 'br' || local === 'cr') {
      append('\n');
    } else if (local === 'noBreakHyphen') {
      append('‑');
    } else if (local === 'fldChar') {
      // A field marker that is deleted or skipped does not change what the visible text shows.
      if (!suppressed) {
        const type = values.get(`${NS_W}|fldCharType`);
        const last = fields[fields.length - 1];
        if (type === 'begin') {
          if (fields.length >= MAX_DEPTH) throw new Error('fields nested too deep');
          fields.push('instruction');
          instructions++;
        } else if (type === 'separate' && last === 'instruction') {
          fields[fields.length - 1] = 'result';
          instructions--;
        } else if (type === 'end' && last) {
          if (fields.pop() === 'instruction') instructions--;
        } else missing.add('a field the copy could not follow');
      }
    } else if (!WRAPPERS.has(local)) {
      note(local, qname);
      // Tables still have their cell text read; everything else unknown is skipped.
      if (local !== 'tbl') open.suppress = true;
    }
    if (selfClosing) {
      if (open.paragraph) paragraphs.push(texts.pop()!);
      continue;
    }
    if (open.suppress) suppressed++;
    stack.push(open);
  }
  if (stack.length) throw new Error(`<${stack[stack.length - 1]!.qname}> is never closed`);
  if (!sawRoot) throw new Error('no root element');
  if (!sawBody) throw new Error('no document body');
  if (fields.length) missing.add('a field the copy could not follow');
  return { paragraphs, missing: [...missing] };
}

/** `uri|local` for a qualified name; an undeclared prefix makes the document malformed. Attributes have no default namespace. */
function resolve(qname: string, ns: Map<string, string>, attribute = false): string {
  const colon = qname.indexOf(':');
  const prefix = colon < 0 ? '' : qname.slice(0, colon);
  const local = colon < 0 ? qname : qname.slice(colon + 1);
  if (attribute && !prefix) return `|${local}`;
  const uri = ns.get(prefix);
  if (uri === undefined && prefix) throw new Error(`an undeclared prefix "${prefix}"`);
  return `${uri ?? ''}|${local}`;
}

/** The readable copy of a Word document: its paragraphs as written, in a fenced block with every line indented. */
export function docxMarkdown(source: string, hash: string, text: DocxText): string {
  const shown = text.paragraphs.map((p) => p.replace(/\s+$/g, '')).filter((p, i, all) => p !== '' || (i > 0 && all[i - 1] !== ''));
  const body = shown.map((p) => p.split(/\r\n?|\n/).map((l) => `  ${l}`).join('\n')).join('\n');
  let longest = 2;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const status = text.missing.length
    ? [`**Incomplete.** The document also has ${text.missing.join(', ')}, which this text copy does not hold as shown. Read the original as well.`]
    : ['**Complete.** Every paragraph of the document body is below, word for word. Headers, footers, comments and footnotes are not part of the body; tracked deletions and field instructions are left out.'];
  return [
    `# Document text: ${source}`,
    '',
    `Readable copy of \`${source}\` (Word document), made by the dashboard. Source SHA-256: \`${hash}\`. The original stays next to this file.`,
    '',
    `- ${text.paragraphs.filter((p) => p.trim()).length} paragraphs with text. Speaker names, if any, appear as written in the document.`,
    '',
    ...status,
    '',
    'The text follows, each line indented by two spaces.',
    '',
    `${fence}text`,
    body,
    fence,
    '',
  ].join('\n');
}
