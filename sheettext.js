/* Extract human-readable text from spreadsheets/documents WITHOUT native deps.
   Why: an inbound .xlsx is a binary ZIP of XML — the model cannot read it from
   a base64 attachment (it answered from chat context instead of the sheet).
   Images work via vision; tabular data must be turned into text first.

   xlsx/docx/pptx are all ZIP containers, so we inflate the relevant XML with
   Node's built-in zlib and strip tags. No third-party libraries. */
const fs = require("fs");
const zlib = require("zlib");

const MAX_CHARS = 16000;    // cap injected into the prompt (free-model context)
const MAX_ROWS = 300;       // per sheet
const MAX_SHEETS = 6;

/* --- minimal ZIP reader (central directory -> local header -> inflate) --- */
function zipEntries(buf) {
  let eo = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out[name] = { method, csize, lho };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function zipRead(buf, entries, name) {
  const e = entries[name];
  if (!e) return null;
  const nameLen = buf.readUInt16LE(e.lho + 26);
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.csize);
  try {
    // every entry we read is XML (or text) — parsers expect a string
    if (e.method === 0) return data.toString("utf8");
    if (e.method === 8) return zlib.inflateRawSync(data).toString("utf8");
  } catch { return null; }
  return null; // other compression methods are not used by Excel/Word
}

/* --- small XML helpers (regex is fine: OOXML is machine-written) --- */
function xmlEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
function tagTexts(xml, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(xmlEntities(m[1].replace(/<[^>]+>/g, "")));
  return out;
}

function colToIdx(ref) {
  // "BC12" -> 54 (0-based column index)
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else break;
  }
  return n - 1;
}

/* --- XLSX --- */
function xlsxToText(buf) {
  const entries = zipEntries(buf);
  const shared = [];
  const ssXml = zipRead(buf, entries, "xl/sharedStrings.xml");
  if (ssXml) {
    const sis = ssXml.match(/<si>[\s\S]*?<\/si>/g) || [];
    for (const si of sis) shared.push(tagTexts(si, "t").join(""));
  }

  // sheet order + names from workbook.xml, targets from its rels
  const wbXml = zipRead(buf, entries, "xl/workbook.xml");
  const relsXml = zipRead(buf, entries, "xl/_rels/workbook.xml.rels");
  const relMap = {};
  if (relsXml) {
    const rels = relsXml.match(/<Relationship[^>]*\/>/g) || [];
    for (const r of rels) {
      const id = /Id="([^"]+)"/.exec(r);
      const tgt = /Target="([^"]+)"/.exec(r);
      if (id && tgt) relMap[id[1]] = tgt[1].replace(/^\//, "").replace(/^xl\//, "");
    }
  }
  const sheets = [];
  if (wbXml) {
    const sre = /<sheet [^>]*\/>/g;
    let m;
    while ((m = sre.exec(wbXml))) {
      const nm = /name="([^"]*)"/.exec(m[0]);
      const rid = /r:id="([^"]+)"/.exec(m[0]) || /id="([^"]+)"/.exec(m[0]);
      const target = rid && relMap[rid[1]] ? "xl/" + relMap[rid[1]] : null;
      sheets.push({ name: xmlEntities(nm ? nm[1] : "Sheet"), target });
    }
  }
  if (!sheets.length) {
    // fallback: every worksheet file in numeric order
    for (const n of Object.keys(entries)) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n)) sheets.push({ name: n, target: n });
    }
  }

  const parts = [];
  let used = 0;
  for (const sh of sheets.slice(0, MAX_SHEETS)) {
    if (!sh.target || used >= MAX_CHARS) continue;
    const sx = zipRead(buf, entries, sh.target);
    if (!sx) continue;
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sx))) {
      const cells = [];
      const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || "";
        const inner = cm[2] || "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const type = /t="([^"]+)"/.exec(attrs);
        const idx = ref ? colToIdx(ref[1]) : cells.length;
        let val = "";
        const t = type ? type[1] : "";
        if (t === "s") {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = shared[parseInt(v[1], 10)] || "";
        } else if (t === "inlineStr") {
          val = tagTexts(inner, "t").join("");
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = xmlEntities(v[1]);
        }
        if (val !== "") {
          while (cells.length < idx) cells.push("");
          cells[idx] = val.replace(/\s+/g, " ").trim();
        }
      }
      const line = cells.join("\t").replace(/\s+$/, "");
      if (line.trim()) rows.push(line);
      if (rows.length >= MAX_ROWS) break;
    }
    if (!rows.length) continue;
    let block = "\n\n[Sheet: " + sh.name + "]\n" + rows.join("\n");
    if (used + block.length > MAX_CHARS) {
      block = block.slice(0, MAX_CHARS - used) + "\n...[truncated]";
    }
    parts.push(block);
    used += block.length;
  }
  if (!parts.length) throw new Error("no readable sheet rows");
  return parts.join("");
}

/* --- DOCX (word/document.xml paragraphs) --- */
function docxToText(buf) {
  const entries = zipEntries(buf);
  const xml = zipRead(buf, entries, "word/document.xml");
  if (!xml) throw new Error("no document.xml");
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
  const lines = [];
  for (const p of paras) {
    const t = tagTexts(p, "w:t").join("");
    if (t.trim()) lines.push(t.trim());
    if (lines.length * 80 >= MAX_CHARS) break;
  }
  if (!lines.length) throw new Error("no paragraphs");
  return "\n\n[Document content]\n" + lines.join("\n").slice(0, MAX_CHARS);
}

/* --- PPTX (slide text) --- */
function pptxToText(buf) {
  const entries = zipEntries(buf);
  const slides = Object.keys(entries)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(/\d+/.exec(a)[0], 10) - parseInt(/\d+/.exec(b)[0], 10)));
  const parts = [];
  let used = 0;
  for (const s of slides.slice(0, MAX_SHEETS)) {
    const xml = zipRead(buf, entries, s);
    if (!xml) continue;
    const texts = tagTexts(xml, "a:t").filter((t) => t.trim());
    if (!texts.length) continue;
    let block = "\n\n[Slide " + (parseInt(/\d+/.exec(s)[0], 10)) + "]\n" + texts.join(" | ");
    if (used + block.length > MAX_CHARS) block = block.slice(0, MAX_CHARS - used);
    parts.push(block);
    used += block.length;
  }
  if (!parts.length) throw new Error("no slide text");
  return parts.join("");
}

const EXTRACTORS = { ".xlsx": xlsxToText, ".xlsm": xlsxToText, ".docx": docxToText, ".pptx": pptxToText };

/* Public: extract text for a file path. Returns { ok, text, error }.
   Plain-text formats (.csv/.txt/.md/.json) are read directly (capped). */
function extract(filePath) {
  const ext = require("path").extname(filePath).toLowerCase();
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, text: "", error: "not a file" };
    if (EXTRACTORS[ext]) {
      const text = EXTRACTORS[ext](fs.readFileSync(filePath));
      return { ok: true, text, error: "" };
    }
    if ([".csv", ".txt", ".md", ".json", ".log", ".tsv"].includes(ext)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return { ok: true, text: "\n\n[File content]\n" + raw.slice(0, MAX_CHARS), error: "" };
    }
    return { ok: false, text: "", error: "unsupported type " + ext };
  } catch (e) {
    return { ok: false, text: "", error: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { extract, xlsxToText, docxToText, pptxToText, MAX_CHARS };
