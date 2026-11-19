/* Tests for item: PDF support — scripts/pdfscan.py extracts text and renders
   pages to PNG (vision) so the model can actually read inbound PDFs.
   Hermetic-ish: builds tiny PDFs in Python (pymupdf is a local dep), no
   network, no assistant session. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const assistant = require("../assistant");

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log("  ok " + name); })
    .catch((e) => { fail++; console.log("  FAIL " + name + " :: " + (e.message || e)); });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pdfscan-"));

function makePdf(name, code) {
  const p = path.join(TMP, name).replace(/\\/g, "/"); // py string literal: no backslashes
  const r = spawnSync("python", ["-c", code.replace(/\{P\}/g, p)], { encoding: "utf8", windowsHide: true });
  if (!fs.existsSync(p)) throw new Error("pdf gen failed: " + (r.stderr || r.stdout || "").slice(0, 300));
  return p;
}

async function main() {
  console.log("pdfscan:");

  const textPdf = makePdf("text.pdf", `
import fitz
d = fitz.open()
pg = d.new_page()
pg.insert_text((72, 72), "Quarterly Revenue Report 2026", fontsize=16)
pg.insert_text((72, 100), "Revenue grew 42 percent year over year.", fontsize=12)
d.save("{P}"); d.close()`);

  // scanned-style: a page with graphics and NO text layer
  const scanPdf = makePdf("scanned.pdf", `
import fitz
d = fitz.open()
pg = d.new_page(width=400, height=300)
pg.draw_rect(fitz.Rect(0, 0, 400, 300), color=(0.2, 0.4, 0.8), fill=(0.9, 0.9, 0.4), width=3)
pg.draw_circle(fitz.Point(200, 150), 60, color=(0.8, 0.1, 0.1), fill=(1, 1, 1), width=2)
d.save("{P}"); d.close()`);

  // genuinely broken file
  const badPdf = path.join(TMP, "bad.pdf");
  fs.writeFileSync(badPdf, "%PDF-1.4 truncated garbage");

  await t("text pdf: text extracted", async () => {
    const r = await assistant._runPdfScan(textPdf);
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.text.includes("Quarterly Revenue Report 2026"), "title extracted");
    assert.ok(r.text.includes("42 percent"), "body extracted");
  });

  await t("text pdf: pages rendered too (short pdf -> vision)", async () => {
    const r = await assistant._runPdfScan(textPdf);
    assert.ok(r.images.length >= 1, "at least one page image");
    for (const img of r.images) {
      assert.ok(fs.existsSync(img), "image exists: " + img);
      assert.ok(fs.statSync(img).size > 1000, "image non-trivial: " + img);
      assert.ok(img.endsWith(".png"));
    }
  });

  await t("scanned pdf (no text layer): renders pages for vision", async () => {
    const r = await assistant._runPdfScan(scanPdf);
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.images.length >= 1, "rendered despite no text");
    assert.ok(fs.statSync(r.images[0]).size > 1000, "png has pixels");
  });

  await t("corrupt pdf: error reported, no throw", async () => {
    const r = await assistant._runPdfScan(badPdf);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.length > 0);
  });

  await t("missing pdf: error reported, no throw", async () => {
    const r = await assistant._runPdfScan(path.join(TMP, "nope.pdf"));
    assert.strictEqual(r.ok, false);
  });

  await t("rendered pages land in chat-inbox (7-day cleanup covers them)", async () => {
    const r = await assistant._runPdfScan(textPdf);
    const inbox = path.join(__dirname, "..", "chat-inbox");
    for (const img of r.images) {
      assert.strictEqual(path.dirname(img), inbox, "inside chat-inbox: " + img);
    }
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // clean rendered probe images from chat-inbox
  try {
    const inbox = path.join(__dirname, "..", "chat-inbox");
    for (const f of fs.readdirSync(inbox)) if (/_pdf_p\d+\.png$/.test(f)) fs.unlinkSync(path.join(inbox, f));
  } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
