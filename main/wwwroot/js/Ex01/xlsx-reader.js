// xlsx-reader.js — 自行實作的 .xlsx 讀取器，零第三方相依。
//
// 依 ECMA-376（OOXML）與 PKWARE APPNOTE（ZIP）規格撰寫，只用原生 Web API：
//   DecompressionStream('deflate-raw')  解壓（取代 fflate / pako）
//   Blob.slice()                        隨機存取（不必把整份 xlsx 讀進記憶體）
//   TextDecoder / DataView              解碼
// 不需要 DOMParser，所以在 Worker 內可直接使用。
//
// 串流設計：sheet 的 XML 是「邊解壓邊掃」的，每解出一列就 callback 一次，
// 呼叫端可以立刻寫掉、不必把所有列堆在記憶體。記憶體佔用 ≈ sharedStrings 查表
// + 當下這一列，與資料列數無關。
//
// 已知不支援（會丟出明確錯誤或明確降級，不會默默算錯）：
//   · ZIP64（>4GB 或 >65535 個 entry）
//   · 加密／密碼保護的 xlsx
//   · .xls（BIFF，舊版二進位格式）

export class XlsxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'XlsxError';
    this.code = code || 'XLSX_ERROR';
  }
}

// ===========================================================================
// ZIP 容器
// ===========================================================================

const SIG_LOCAL = 0x04034b50;   // local file header
const SIG_CENTRAL = 0x02014b50; // central directory file header
const SIG_EOCD = 0x06054b50;    // end of central directory
const SIG_EOCD64 = 0x06064b50;  // ZIP64 end of central directory
const MAX_COMMENT = 0xffff;

async function sliceBuffer(blob, start, end) {
  return await blob.slice(start, end).arrayBuffer();
}

/**
 * 從檔尾往前找 End Of Central Directory 記錄。
 * EOCD 最少 22 bytes，後面可能還跟著最多 64KB 的註解，所以最多往前找 22+65535。
 */
async function findEocd(blob) {
  const tailLen = Math.min(blob.size, 22 + MAX_COMMENT);
  const buf = await sliceBuffer(blob, blob.size - tailLen, blob.size);
  const view = new DataView(buf);
  for (let i = view.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      return { view, offsetInFile: blob.size - tailLen, at: i };
    }
    if (view.getUint32(i, true) === SIG_EOCD64) {
      throw new XlsxError('這是 ZIP64 格式的檔案，本讀取器不支援', 'ZIP64_NOT_SUPPORTED');
    }
  }
  return null;
}

/** xlsx 必須以 PK\x03\x04 開頭；.xls 是另一種格式，給出明確訊息比較好排查 */
async function assertLooksLikeXlsx(blob) {
  if (blob.size < 22) throw new XlsxError('檔案太小，不是有效的 .xlsx', 'FILE_TOO_SMALL');
  const head = new Uint8Array(await sliceBuffer(blob, 0, 8));
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new XlsxError('這是舊版 .xls（BIFF）格式，不是 .xlsx', 'XLS_NOT_SUPPORTED');
  }
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    throw new XlsxError('檔案開頭不是 ZIP 簽章，不像是 .xlsx', 'NOT_A_ZIP');
  }
}

/**
 * 讀 central directory，回傳 name → entry 的對照表。
 * 只讀 central directory 那一段 bytes，不讀整個檔案。
 */
async function readEntries(blob) {
  await assertLooksLikeXlsx(blob);

  const eocd = await findEocd(blob);
  if (!eocd) throw new XlsxError('找不到 ZIP 的 End Of Central Directory 記錄', 'NO_EOCD');

  const { view, at } = eocd;
  const count = view.getUint16(at + 10, true);
  const cdSize = view.getUint32(at + 12, true);
  const cdOffset = view.getUint32(at + 16, true);

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    throw new XlsxError('這是 ZIP64 格式的檔案，本讀取器不支援', 'ZIP64_NOT_SUPPORTED');
  }

  const cdBuf = await sliceBuffer(blob, cdOffset, cdOffset + cdSize);
  const cd = new DataView(cdBuf);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();

  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) {
      throw new XlsxError('central directory 第 ' + i + ' 筆的簽章不正確', 'BAD_CENTRAL_DIRECTORY');
    }
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const compressedSize = cd.getUint32(p + 20, true);
    const uncompressedSize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cdBuf, p + 46, nameLen));

    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 算出 entry 實際壓縮資料在檔案中的位置。
 * ★必須讀 local file header 的 extra field 長度 —— 它可以與 central directory 裡的不同。
 */
async function entryDataRange(blob, entry) {
  const buf = await sliceBuffer(blob, entry.localOffset, entry.localOffset + 30);
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== SIG_LOCAL) {
    throw new XlsxError('"' + entry.name + '" 的 local file header 簽章不正確', 'BAD_LOCAL_HEADER');
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  return { start, end: start + entry.compressedSize };
}

/**
 * 進度計數用的 pass-through：只累加 byteLength，不動內容。
 * ★插在 DecompressionStream 之後，所以量到的是「解壓後」的 bytes ——
 *   與 central directory 的 uncompressedSize 同一個尺度，兩者才能相除。
 *
 * 取捨：TransformStream 預設 highWaterMark 是 1，所以計數會比「已解析完」
 * 超前最多一個 chunk，且多緩衝一個 chunk（~64KB）。相對於本檔案「記憶體
 * 不隨資料列數成長」的主張，這是一個常數、可接受。
 */
function countingTransform(onBytes) {
  return new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);   // chunk 是傳參考，不複製
    },
  });
}

/**
 * 取得某個 entry 解壓後的 byte 串流（method 0 = 未壓縮，8 = deflate）
 * @param {(n:number)=>void} [onBytes] 選用：每個 chunk 回報解壓後的 byte 數
 */
async function entryStream(blob, entry, onBytes) {
  const { start, end } = await entryDataRange(blob, entry);
  const raw = blob.slice(start, end);
  let stream;
  if (entry.method === 0) stream = raw.stream();
  else if (entry.method === 8) stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  else throw new XlsxError('"' + entry.name + '" 使用不支援的壓縮方法 ' + entry.method, 'UNSUPPORTED_COMPRESSION');
  // ★沒給 onBytes 就完全不插 transform —— 不使用進度回報的呼叫端
  //   （readXlsxFile、self-test）走的是與加這個功能之前一字不差的程式路徑。
  return onBytes ? stream.pipeThrough(countingTransform(onBytes)) : stream;
}

/** 把整個 entry 讀成字串（只用於 workbook/rels/styles/sharedStrings 這類中小型部件） */
async function entryText(blob, entry, onBytes) {
  return await new Response(await entryStream(blob, entry, onBytes)).text();
}

// ===========================================================================
// XML：一個 tokenizer + 一棵小節點樹（不需要 DOM）
// ===========================================================================
//
// 設計取捨：串流層（streamElements）一次交出「一個完整的元素字串」，
// 元素內部再用 parseXml 變成小節點樹來讀。
//
// 為什麼不是純 SAX：純 SAX 會把「一格的值怎麼決定」拆進 open/text/close 三個
// handler，得靠一堆狀態變數重建上下文，反而比較難讀。用小節點樹的話，
// parseCell / parseRow 各自一個函式就看得完。
//
// 為什麼不是整份 DOM：那會把整個 sheet 讀進記憶體，破壞串流。
// 節點樹一次只存「一列」，所以記憶體仍與列數無關。
//
// XML 文法只在 nextToken() 這一個地方處理；其他地方都只用節點查詢。

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解碼 XML 實體：&amp; &lt; &gt; &quot; &apos; &#20320; &#x4f60; */
export function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/** 去掉命名空間前綴："x:row" → "row"、"row" → "row" */
const localNameOf = (name) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

/**
 * 掃出 s[pos] 開始的下一個 XML 語法單元 —— 整份檔案唯一處理 XML 文法的地方。
 *
 * 回傳 null        = 已到字串結尾
 * 回傳 'incomplete' = 這個單元還沒收完（串流時要等更多資料才能判斷）
 *
 * 這裡負責處理所有「用正規表達式會踩到」的細節：
 *   · 註解 `<!-- ... -->`、CDATA `<![CDATA[ ... ]]>`、PI `<? ... ?>`、DOCTYPE
 *   · 屬性值裡可以合法出現 `>`（XML 只強制轉義 `<` 與 `&`）
 *   · 命名空間前綴 `<x:row>`
 *   · `<x/>` 與 `<x>…</x>` 兩種寫法
 */
function nextToken(s, pos) {
  if (pos >= s.length) return null;

  // 文字：一路吃到下一個 '<'
  if (s[pos] !== '<') {
    const lt = s.indexOf('<', pos);
    const end = lt === -1 ? s.length : lt;
    return { type: 'text', start: pos, end, raw: s.slice(pos, end) };
  }

  if (s.startsWith('<!--', pos)) {                       // 註解：整段跳過
    const e = s.indexOf('-->', pos + 4);
    return e === -1 ? 'incomplete' : { type: 'skip', start: pos, end: e + 3 };
  }
  if (s.startsWith('<![CDATA[', pos)) {                  // CDATA：內容照原樣當文字
    const e = s.indexOf(']]>', pos + 9);
    return e === -1 ? 'incomplete' : { type: 'cdata', start: pos, end: e + 3, raw: s.slice(pos + 9, e) };
  }
  if (s.startsWith('<?', pos)) {                         // <?xml … ?> 等 PI
    const e = s.indexOf('?>', pos + 2);
    return e === -1 ? 'incomplete' : { type: 'skip', start: pos, end: e + 2 };
  }
  if (s.startsWith('<!', pos)) {                         // <!DOCTYPE …>（xlsx 不會有）
    const e = s.indexOf('>', pos + 2);
    return e === -1 ? 'incomplete' : { type: 'skip', start: pos, end: e + 1 };
  }
  if (s.startsWith('</', pos)) {                         // 結束標籤
    const e = s.indexOf('>', pos + 2);
    if (e === -1) return 'incomplete';
    const name = s.slice(pos + 2, e).trim();
    return { type: 'close', start: pos, end: e + 1, name, local: localNameOf(name) };
  }

  // 起始標籤：先取名字，再一路找到標籤結尾的 '>'（★引號內的 '>' 不算）
  let i = pos + 1;
  while (i < s.length && !/[\s/>]/.test(s[i])) i++;
  if (i >= s.length) return 'incomplete';
  const name = s.slice(pos + 1, i);

  const attrStart = i;
  let quote = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') break;
    i++;
  }
  if (i >= s.length) return 'incomplete';

  const selfClosing = s[i - 1] === '/';
  return {
    type: selfClosing ? 'self' : 'open',
    start: pos, end: i + 1,
    name, local: localNameOf(name),
    attrStart, attrEnd: selfClosing ? i - 1 : i,
  };
}

/**
 * 解析起始標籤裡的屬性。屬性名以「去掉前綴」為 key，
 * 所以 `r:id` 與 `id` 都用 `attr('id')` 取得。
 * 標籤的邊界已由 nextToken 以「引號感知」的方式切好，這裡只需拆 name="value"。
 */
function parseAttributes(s, start, end) {
  const attrs = {};
  const segment = s.slice(start, end);
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    attrs[localNameOf(m[1])] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

/**
 * 一個 XML 元素。刻意做得很小 —— 只提供讀取 xlsx 真正需要的查詢，
 * 讓呼叫端讀起來像 OOXML 規格描述本身。
 */
class XmlNode {
  constructor(name, local, attrs) {
    this.name = name;      // 含前綴，例如 "x:row"
    this.local = local;    // 不含前綴，例如 "row"
    this.attrs = attrs;    // { 去前綴的屬性名: 已解實體的值 }
    this.nodes = [];       // 子元素
    this.chunks = [];      // 直屬文字（含 CDATA）
  }

  /** 直屬文字內容（`<v>123</v>` → "123"）；不含子元素裡的文字 */
  get text() { return this.chunks.join(''); }

  /** 屬性值，沒有就回 null */
  attr(local) {
    const v = this.attrs[local];
    return v === undefined ? null : v;
  }

  /** 屬性值轉數字；沒有或不是數字就回 null */
  num(local) {
    const v = this.attr(local);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** 第一個同名的直接子元素，沒有就回 null */
  child(local) {
    for (const n of this.nodes) if (n.local === local) return n;
    return null;
  }

  /** 同名的直接子元素清單（省略 local 就是全部） */
  children(local) {
    return local === undefined ? this.nodes : this.nodes.filter((n) => n.local === local);
  }

  /** 第一個同名的後代元素（深度優先），沒有就回 null */
  find(local) {
    for (const n of this.nodes) {
      if (n.local === local) return n;
      const deeper = n.find(local);
      if (deeper) return deeper;
    }
    return null;
  }

  /**
   * 所有同名的後代元素。
   * options.notInside：整棵子樹都跳過（用於排除 `<rPh>` 假名注音）
   */
  findAll(local, options) {
    const skip = options && options.notInside;
    const out = [];
    const walk = (node) => {
      for (const n of node.nodes) {
        if (skip && n.local === skip) continue;
        if (n.local === local) out.push(n);
        walk(n);
      }
    };
    walk(this);
    return out;
  }
}

/**
 * 把一段 XML 解析成節點樹，回傳根節點（文件節點）。
 *
 * 刻意「寬容」：遇到被截斷的內容或多餘的結束標籤都不丟錯，
 * 因為我們也用它解析「只讀了開頭一小段」的 worksheet（為了拿 `<dimension>`）。
 */
export function parseXml(xml) {
  const doc = new XmlNode('#document', '#document', {});
  const stack = [doc];
  let pos = 0;

  for (;;) {
    const tok = nextToken(xml, pos);
    if (tok === null || tok === 'incomplete') break;
    pos = tok.end;
    const parent = stack[stack.length - 1];

    switch (tok.type) {
      case 'open': {
        const node = new XmlNode(tok.name, tok.local, parseAttributes(xml, tok.attrStart, tok.attrEnd));
        parent.nodes.push(node);
        stack.push(node);
        break;
      }
      case 'self':
        parent.nodes.push(new XmlNode(tok.name, tok.local, parseAttributes(xml, tok.attrStart, tok.attrEnd)));
        break;
      case 'close':
        // 只有堆疊裡真的有這個元素才收掉，多餘的結束標籤直接忽略
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].local === tok.local) { stack.length = i; break; }
        }
        break;
      case 'text': {
        const t = decodeEntities(tok.raw);
        if (t) parent.chunks.push(t);
        break;
      }
      case 'cdata':
        parent.chunks.push(tok.raw);      // CDATA 內不解實體
        break;
      // 'skip'（註解 / PI / DOCTYPE）什麼都不做
    }
  }
  return doc;
}

/**
 * 在 buf 裡找出第一個 local 名稱相符的完整元素。
 * 用 nextToken 逐單元前進，所以註解裡的 `<row>` 不會被誤認成資料列。
 *
 * @returns {{kind:'found', start:number, end:number}
 *          | {kind:'incomplete'|'none', keepFrom:number}}
 *   keepFrom：buf 在這個位置之前的內容都可以丟掉（用來限制緩衝區大小）
 */
function findElementRange(buf, local) {
  let pos = 0;
  let start = -1;
  let depth = 0;

  for (;;) {
    const tok = nextToken(buf, pos);
    if (tok === null || tok === 'incomplete') {
      return start === -1
        ? { kind: 'none', keepFrom: pos }        // 還沒開始，丟掉已掃完的部分
        : { kind: 'incomplete', keepFrom: start }; // 開頭已出現，保留它等後續 chunk
    }
    pos = tok.end;

    if (start === -1) {
      if (tok.local !== local) continue;
      if (tok.type === 'self') return { kind: 'found', start: tok.start, end: tok.end };
      if (tok.type === 'open') { start = tok.start; depth = 1; }
    } else if (tok.local === local) {
      if (tok.type === 'open') depth++;
      else if (tok.type === 'close' && --depth === 0) {
        return { kind: 'found', start, end: tok.end };
      }
    }
  }
}

/**
 * 邊解壓邊掃：從 stream 裡逐一吐出名為 local 的元素（完整 XML 字串）。
 * 緩衝區裡最多只留「尚未收完的那一個元素」，所以記憶體不隨檔案成長。
 */
async function* streamElements(stream, local) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  const drain = function* () {
    for (;;) {
      const r = findElementRange(buf, local);
      if (r.kind !== 'found') { buf = buf.slice(r.keepFrom); return; }
      yield buf.slice(r.start, r.end);
      buf = buf.slice(r.end);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* drain();
    }
    buf += decoder.decode();
    yield* drain();
  } finally {
    try { reader.cancel(); } catch { /* 已經讀完就不管了 */ }
  }
}

/**
 * 元素底下所有 `<t>` 的文字串接起來。
 * 規則直接寫成規則：要 `<t>` 的文字，但不要 `<rPh>`（日文假名注音）裡的。
 */
function textOf(node) {
  if (!node) return '';
  return node.findAll('t', { notInside: 'rPh' }).map((t) => t.text).join('');
}

// ===========================================================================
// sharedStrings.xml
// ===========================================================================

/**
 * 讀共用字串表。這是「查表」，必須整份在記憶體裡；
 * 但它的大小取決於「不重複字串數」，不是資料列數。
 */
async function readSharedStrings(blob, entries, onBytes) {
  const entry = entries.get('xl/sharedStrings.xml');
  if (!entry) return [];
  const strings = [];
  for await (const siXml of streamElements(await entryStream(blob, entry, onBytes), 'si')) {
    strings.push(textOf(parseXml(siXml)));
  }
  return strings;
}

// ===========================================================================
// styles.xml —— 只為了判斷「這個儲存格是不是日期」
// ===========================================================================

// ECMA-376 內建的日期／時間格式編號
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,           // 日期與時間
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,       // 東亞日期
  45, 46, 47,                                    // mm:ss / [h]:mm:ss / mmss.0
  50, 51, 52, 53, 54, 55, 56, 57, 58,           // 東亞日期（續）
]);

/**
 * 自訂格式碼是不是日期／時間？
 * 要先剝掉不算格式符號的部分，否則 `"年"` 或 `[Red]` 裡的字母會誤判。
 */
export function isDateFormatCode(code) {
  if (!code) return false;
  const stripped = code
    .replace(/\\./g, '')          // 轉義字元 \x
    .replace(/"[^"]*"/g, '')      // "字面字串"
    .replace(/'[^']*'/g, '')      // '字面字串'
    .replace(/\[[^\]]*\]/g, '');  // [Red] [$-409] [h] 之類的區段
  if (/General/i.test(stripped)) return false;
  return /[ymdhs]/i.test(stripped);
}

/** 回傳 styleIndex → 是否為日期格式 的陣列 */
async function readStyles(blob, entries, onBytes) {
  const entry = entries.get('xl/styles.xml');
  if (!entry) return { isDateStyle: [] };
  // ★這一段是全流程最容易久停的地方：entryText 讀整份 + parseXml 建完整節點樹，
  //   沒有串流也沒有增量釋放。企業檔的 cellXfs/dxfs 動輒上千筆。
  //   所以它的 bytes 一定要計進進度，否則進度條會停在一個看起來很合理的中間數字。
  const doc = parseXml(await entryText(blob, entry, onBytes));

  // 自訂格式：<numFmt numFmtId="164" formatCode="yyyy/m/d"/>
  const customIsDate = new Map();
  for (const numFmt of doc.find('numFmts')?.children('numFmt') ?? []) {
    const id = numFmt.num('numFmtId');
    if (id !== null) customIsDate.set(id, isDateFormatCode(numFmt.attr('formatCode')));
  }

  // cellXfs 的順序就是儲存格 s="N" 的索引
  const isDateStyle = (doc.find('cellXfs')?.children('xf') ?? []).map((xf) => {
    const id = xf.num('numFmtId');
    if (id === null) return false;
    return customIsDate.has(id) ? customIsDate.get(id) : BUILTIN_DATE_FORMATS.has(id);
  });

  return { isDateStyle };
}

// ===========================================================================
// workbook.xml —— 工作表清單、日期系統
// ===========================================================================

function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir + target).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// ★這裡刻意不接進度回報（entryText 都不傳 onBytes）：
//   workbook.xml / rels 必須在「還沒解析出 sheetEntry」時就讀，此時進度的分母
//   （sharedStrings + styles + sheet 的 uncompressedSize 總和）還算不出來。
//   若把這些 bytes 也計進去、分母卻是後來才變大的，比例就會往回跳。
//   它們也只有幾 KB，漏掉不影響觀感。
async function readWorkbook(blob, entries) {
  const entry = entries.get('xl/workbook.xml');
  if (!entry) throw new XlsxError('壓縮檔裡找不到 xl/workbook.xml', 'NO_WORKBOOK');
  const doc = parseXml(await entryText(blob, entry));

  const date1904Attr = doc.find('workbookPr')?.attr('date1904');
  const date1904 = date1904Attr === '1' || date1904Attr === 'true';

  // 屬性名已去掉前綴，所以 r:id 直接用 attr('id') 取得
  const sheets = (doc.find('sheets')?.children('sheet') ?? []).map((sheet) => ({
    name: sheet.attr('name'),
    relId: sheet.attr('id'),
  }));
  if (!sheets.length) throw new XlsxError('workbook.xml 裡沒有任何工作表', 'NO_SHEETS');

  // rels：rId → 實際部件路徑
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (relsEntry) {
    const relsDoc = parseXml(await entryText(blob, relsEntry));
    for (const rel of relsDoc.find('Relationships')?.children('Relationship') ?? []) {
      const id = rel.attr('Id');
      const target = rel.attr('Target');
      if (id && target) relMap.set(id, resolvePath('xl/', target));
    }
  }

  for (const sheet of sheets) {
    sheet.path = (sheet.relId && relMap.get(sheet.relId)) || null;
  }
  return { sheets, date1904 };
}

// ===========================================================================
// 儲存格
// ===========================================================================

/** "C" → 2、"AA" → 26。忽略 ref 裡的列號部分。 */
export function refToColumnIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);          // A-Z
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);    // a-z（保險）
    else break;                                              // 碰到數字就結束
  }
  return n - 1;
}

const MS_PER_DAY = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * Excel 日期序號 → Date。
 *
 * 1900 系統有個歷史包袱：Excel 把 1900 當閏年，序號 60 是不存在的 1900-02-29。
 * 因此序號 < 60 要 +1 天才對得上；序號 60 本身是假日期，這裡會落在 1900-02-28。
 * 實務資料幾乎不會用到 1900 年初，這個邊界僅此說明。
 */
export function serialToDate(serial, date1904) {
  if (!Number.isFinite(serial)) return null;
  if (date1904) return new Date(EPOCH_1904 + Math.round(serial * MS_PER_DAY));
  const days = serial < 60 ? serial + 1 : serial;
  return new Date(EPOCH_1900 + Math.round(days * MS_PER_DAY));
}

/**
 * 解析單一 <c> 元素。
 * 型別（t 屬性）：s = sharedStrings 索引、inlineStr = 內嵌字串、
 * str = 公式的快取字串、b = 布林、e = 錯誤值、n 或省略 = 數字。
 */
function parseCell(cell, ctx) {
  const type = cell.attr('t') ?? 'n';

  if (type === 'inlineStr') return textOf(cell.child('is'));

  // 儲存格底下除了 <v> 還可能有 <f>（公式本身），這裡只取 <v> 的快取值。
  // 空的儲存格（`<c/>` 或只有樣式沒有值）沒有 <v>，回 null。
  const v = cell.child('v');
  if (!v) return null;
  const rawText = v.text;

  switch (type) {
    case 's': {
      const s = ctx.sharedStrings[Number(rawText)];
      return s === undefined ? null : s;
    }
    case 'str':
      return rawText;
    case 'b':
      return rawText === '1' || rawText === 'true';
    case 'e':
      return rawText;                                  // 例如 #DIV/0!，原樣保留
    default: {
      if (rawText === '') return null;
      const num = Number(rawText);
      if (!Number.isFinite(num)) return rawText;       // 不是數字就原樣保留
      const styleIndex = cell.num('s');
      if (styleIndex !== null && ctx.isDateStyle[styleIndex]) {
        return serialToDate(num, ctx.date1904);
      }
      return num;
    }
  }
}

/** 解析單一 <row>，依 ref 的欄號把值放到正確位置，空缺補 null */
function parseRow(row, ctx) {
  const cells = [];
  let autoCol = 0;

  for (const cell of row.children('c')) {
    const ref = cell.attr('r');

    // ★沒有 ref 時才用順序遞增；有 ref 就照 ref 定位 ——
    //   Excel 會省略空白儲存格，忽略 ref 會讓整列欄位左移。
    const col = ref ? refToColumnIndex(ref) : autoCol;
    autoCol = (col < 0 ? autoCol : col) + 1;
    if (col < 0) continue;

    while (cells.length < col) cells.push(null);
    cells[col] = parseCell(cell, ctx);
  }
  return cells;
}

// ===========================================================================
// 對外 API
// ===========================================================================

/**
 * 串流讀取一個工作表，每解出一列就呼叫 onRow(cells, rowIndex)。
 *
 * @param {Blob|File} blob   .xlsx 檔
 * @param {object}   options
 * @param {(cells:any[], rowIndex:number)=>void} options.onRow 每一列的 callback
 * @param {string|number} [options.sheet]  工作表名稱或 0-based 序號，預設第一個
 * @param {boolean} [options.padRows=true] 依 <dimension> 把每列補齊到相同欄數
 * @param {(p:{phase:string,loaded:number,total:number|null,ratio:number|null,rowCount:number})=>void}
 *        [options.onProgress] 選用：解壓進度回報。ratio 為 null 表示分母不可信（不確定模式）。
 * @returns {Promise<{rowCount:number, columnCount:number, sheetName:string}>}
 */
export async function readXlsxRows(blob, options = {}) {
  const { onRow, sheet, padRows = true, onProgress } = options;
  if (typeof onRow !== 'function') throw new XlsxError('需要 options.onRow callback', 'NO_CALLBACK');

  const entries = await readEntries(blob);
  const { sheets, date1904 } = await readWorkbook(blob, entries);

  let target;
  if (typeof sheet === 'string') {
    target = sheets.find(s => s.name === sheet);
    if (!target) {
      throw new XlsxError('找不到工作表 "' + sheet + '"，可用的是：'
        + sheets.map(s => s.name).join(', '), 'SHEET_NOT_FOUND');
    }
  } else {
    target = sheets[typeof sheet === 'number' ? sheet : 0];
    if (!target) throw new XlsxError('找不到指定序號的工作表', 'SHEET_NOT_FOUND');
  }

  const sheetPath = target.path || 'xl/worksheets/sheet1.xml';
  const sheetEntry = entries.get(sheetPath);
  if (!sheetEntry) throw new XlsxError('壓縮檔裡找不到 ' + sheetPath, 'SHEET_PART_MISSING');

  // ---- 進度：分母在這裡一次算定（sheetEntry 已確認），之後永不改變 ----
  //
  // 分子是「實際解壓出來的 bytes」，分母是 central directory 已經解出來的
  // uncompressedSize 總和 —— 不猜、不估、不用時間內插。
  const MAX_U32 = 0xffffffff;
  const partSize = (e) => (e ? e.uncompressedSize : 0);   // 部件不存在 → 0，這是正確的貢獻值
  const sizes = [
    partSize(entries.get('xl/sharedStrings.xml')),
    partSize(entries.get('xl/styles.xml')),
    partSize(sheetEntry),
  ];
  // central directory 的 uncompressedSize 一般可信：flags bit 3（data descriptor）
  // 只會把 local file header 裡的 size 歸零，而本讀取器從不從 local header 讀 size
  // （entryDataRange 只取 nameLen/extraLen）。但兩種情況分母不可用：
  //   0xffffffff = 逐項 ZIP64 佔位；sheet 為 0 = 寫入器根本沒填。
  // 這兩種就不報百分比，改走「不確定模式」（ratio = null）。
  const total = (sizes.every((n) => Number.isFinite(n) && n !== MAX_U32) && partSize(sheetEntry) > 0)
    ? sizes.reduce((a, b) => a + b, 0)
    : 0;   // 0 = 不確定

  let rowCount = 0;   // ★從下面 hoist 上來，讓 emit() 讀得到目前列數
  let phase = 'sharedStrings';
  let loaded = 0;

  const emit = (ratioOverride) => {
    if (!onProgress) return;
    try {
      onProgress({
        phase,
        loaded,                                   // ★不 clamp：誠實回報實際解壓 bytes
        total: total || null,                     // null = 不確定
        ratio: ratioOverride ?? (total ? Math.min(1, loaded / total) : null),
        rowCount,
      });
    } catch { /* 進度回報自己出錯，不該讓解析失敗 */ }
  };
  // ★用閉包而不是 this：onBytes 會被當成裸函式參考傳進 entryStream。
  const onBytes = onProgress ? (n) => { loaded += n; emit(); } : null;
  const setPhase = (p) => { phase = p; emit(); };

  const sharedStrings = await readSharedStrings(blob, entries, onBytes);
  setPhase('styles');
  const { isDateStyle } = await readStyles(blob, entries, onBytes);
  const ctx = { sharedStrings, isDateStyle, date1904 };

  // <dimension ref="A1:D251"> 可以先知道欄數，用來把每列補齊。
  // 它一定出現在 <sheetData> 之前，所以只掃開頭一小段就好。
  let columnCount = 0;
  if (padRows) {
    setPhase('dimension');
    // ★這裡刻意不傳 onBytes：這是第二次開同一個 sheet 串流，
    //   計進去會把開頭那幾個 chunk 重複算一次，比例會超過 100%。
    const reader = (await entryStream(blob, sheetEntry)).getReader();
    const decoder = new TextDecoder('utf-8');
    let head = '';
    try {
      while (head.length < 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        head += decoder.decode(value, { stream: true });
        if (head.indexOf('<sheetData') !== -1) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    // parseXml 對被截斷的片段是寬容的，所以直接餵這段開頭就行
    const ref = parseXml(head).find('dimension')?.attr('ref') ?? null;
    if (ref) {
      const last = ref.split(':').pop();
      const col = refToColumnIndex(last);
      if (col >= 0) columnCount = col + 1;
    }
  }

  // 正式串流掃 <row>（rowCount 已在上方進度區塊宣告）
  let maxCols = columnCount;
  let expectedRowNumber = 1;

  setPhase('sheet');
  // <row> 只會出現在 <sheetData> 裡；<rowBreaks> 之類的同前綴標籤由 tokenizer 區分。
  for await (const rowXml of streamElements(await entryStream(blob, sheetEntry, onBytes), 'row')) {
    const row = parseXml(rowXml).child('row');
    if (!row) continue;
    const rNum = row.num('r');

    // Excel 會整列省略空白列。補回空白列，NDJSON 的列序才對得上試算表的列號。
    if (rNum !== null && rNum > expectedRowNumber) {
      for (let missing = expectedRowNumber; missing < rNum; missing++) {
        const blank = columnCount ? new Array(columnCount).fill(null) : [];
        onRow(blank, rowCount++);
      }
    }

    const cells = parseRow(row, ctx);
    if (cells.length > maxCols) maxCols = cells.length;
    // 補齊到 dimension 宣告的欄數；若某列實際超出 dimension，就照實保留不截斷。
    if (columnCount) {
      while (cells.length < columnCount) cells.push(null);
    }
    onRow(cells, rowCount++);
    expectedRowNumber = (rNum !== null ? rNum : expectedRowNumber) + 1;
  }

  // ★只在成功路徑畫 100%：絕對不要放進 finally。
  //   列迴圈丟例外時走不到這裡，才不會在紅色錯誤訊息底下畫出一條完成的進度條。
  //   emit(1) 強制 ratio = 1 但保留真實 loaded，所以不確定模式下也知道已完成。
  phase = 'done';
  emit(1);

  return { rowCount, columnCount: maxCols, sheetName: target.name };
}

/**
 * 方便用的版本：一次回傳整個二維陣列。
 * 這會把所有列留在記憶體，只適合小檔案或測試比對；
 * 正式流程請用 readXlsxRows() 的串流 callback。
 */
export async function readXlsxFile(blob, options = {}) {
  const rows = [];
  await readXlsxRows(blob, { ...options, onRow: (cells) => rows.push(cells) });
  return rows;
}
