/* Tests for sheettext.js — the binary-spreadsheet -> prompt-text fix.
   Hermetic: builds a tiny xlsx in memory (stored ZIP entries; our reader
   doesn't verify CRC so bytes just need valid structure). */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sheettext = require("../sheettext");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " :: " + e.message); }
}

/* --- minimal ZIP writer (stored = no compression) --- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) { // files: [{name, data:Buffer}]
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);      // method: stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    chunks.push(lh, nameB, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameB]));
    offset += 30 + nameB.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

function buildXlsx() {
  const wb = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Quiz" sheetId="1" r:id="rId1"/><sheet name="Key" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;
  const ss = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>Name</t></si><si><t>Score</t></si><si><t>Qiskit &amp; Friends</t></si></sst>`;
  const sheet1 = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>87</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Ada</t></is></c><c r="B3"><v>92</v></c></row>
</sheetData></worksheet>`;
  const sheet2 = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>`;
  return makeZip([
    { name: "xl/workbook.xml", data: Buffer.from(wb) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels) },
    { name: "xl/sharedStrings.xml", data: Buffer.from(ss) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet1) },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(sheet2) },
  ]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sheettext-"));
const XLSX = path.join(TMP, "quiz.xlsx");
fs.writeFileSync(XLSX, buildXlsx());

console.log("sheettext:");

t("xlsx: shared strings resolve", () => {
  const r = sheettext.extract(XLSX);
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.text.includes("Qiskit & Friends"), "entity decode + shared string");
  assert.ok(r.text.includes("87"), "numeric cell");
});

t("xlsx: sheet names in output", () => {
  const r = sheettext.extract(XLSX);
  assert.ok(r.text.includes("[Sheet: Quiz]"));
  assert.ok(r.text.includes("[Sheet: Key]"));
});

t("xlsx: columns align as TSV (B2 under B1)", () => {
  const r = sheettext.extract(XLSX);
  const lines = r.text.split("\n");
  const hdr = lines.find((l) => l.startsWith("Name"));
  const row = lines.find((l) => l.startsWith("Qiskit"));
  assert.ok(hdr && row, "header + data row present");
  assert.strictEqual(hdr.split("\t")[1], "Score");
  assert.strictEqual(row.split("\t")[1], "87");
});

t("xlsx: inlineStr cells read", () => {
  const r = sheettext.extract(XLSX);
  assert.ok(r.text.includes("Ada"));
});

t("csv: read as text", () => {
  const p = path.join(TMP, "a.csv");
  fs.writeFileSync(p, "a,b\n1,2\n");
  const r = sheettext.extract(p);
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes("a,b"));
});

t("txt: read as text", () => {
  const p = path.join(TMP, "n.txt");
  fs.writeFileSync(p, "hello");
  assert.ok(sheettext.extract(p).text.includes("hello"));
});

t("unsupported: pdf reports error, no throw", () => {
  const p = path.join(TMP, "d.pdf");
  fs.writeFileSync(p, "%PDF-1.4");
  const r = sheettext.extract(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes("unsupported"));
});

t("corrupt: garbage xlsx reports error, no throw", () => {
  const p = path.join(TMP, "bad.xlsx");
  fs.writeFileSync(p, "this is not a zip at all");
  const r = sheettext.extract(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.length > 0);
});

t("missing: file not found reports error, no throw", () => {
  const r = sheettext.extract(path.join(TMP, "nope.xlsx"));
  assert.strictEqual(r.ok, false);
});

t("docx: paragraphs extracted", () => {
  const doc = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>Project Expo</w:t></w:r></w:p><w:p><w:r><w:t>30-11-2026</w:t></w:r></w:p></w:body></w:document>`;
  const zip = makeZip([{ name: "word/document.xml", data: Buffer.from(doc) }]);
  const p = path.join(TMP, "d.docx");
  fs.writeFileSync(p, zip);
  const r = sheettext.extract(p);
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.text.includes("Project Expo") && r.text.includes("30-11-2026"));
});

t("pptx: slide text extracted", () => {
  const slide = `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hello Deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const zip = makeZip([{ name: "ppt/slides/slide1.xml", data: Buffer.from(slide) }]);
  const p = path.join(TMP, "s.pptx");
  fs.writeFileSync(p, zip);
  const r = sheettext.extract(p);
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.text.includes("Hello Deck"));
});

t("size cap: huge text truncated at MAX_CHARS", () => {
  const big = "x".repeat(sheettext.MAX_CHARS + 5000);
  const p = path.join(TMP, "big.txt");
  fs.writeFileSync(p, big);
  const r = sheettext.extract(p);
  assert.ok(r.text.length <= sheettext.MAX_CHARS + 100, "capped, got " + r.text.length);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
