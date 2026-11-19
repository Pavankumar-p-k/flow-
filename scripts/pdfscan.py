"""PDF -> text + page images for the notch assistant.

Why: an inbound .pdf is binary — the model cannot read it from a base64
attachment (it said \"I got the file but I can't read it\"). Two paths:
  - text PDFs   -> extract the text (fast, covers summaries)
  - scanned / short PDFs (diagrams!) -> render pages to PNG so the model can
    LOOK at them with vision, which is what the user asked for.

Run: python scripts/pdfscan.py <pdf-path> <out-dir>
Prints one JSON line:
  {"text": "...", "images": ["C:\\...\\1795_x_pdf_p1.png", ...], "pages": N}
  or {"error": "..."}
"""
import json
import os
import sys
import time

# Windows stdout defaults to cp1252 — PDF text often carries private-use
# glyphs (fonts embed custom chars) and print() would crash with charmap
# errors. Always emit UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MAX_IMAGES = 6       # never render more pages than this
DPI = 140            # ~1157x1637 for A4 — sharp enough for vision, small body
THIN_TEXT = 40       # avg chars/page below this = scanned -> needs vision
SHORT_PDF = 8        # pages at or below this also get renders (diagrams)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: pdfscan.py <pdf> <out-dir>"}))
        return 1
    pdf_path, out_dir = sys.argv[1], sys.argv[2]
    try:
        import fitz  # pymupdf
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "pymupdf unavailable: %s" % e}))
        return 1
    try:
        doc = fitz.open(pdf_path)
        if doc.page_count == 0:
            print(json.dumps({"error": "pdf has no pages"}))
            return 1
        text = "\n".join(t for t in (doc[i].get_text() for i in range(doc.page_count)) if t).strip()
        pages = doc.page_count
        avg = len(text) / max(1, pages)
        images = []
        if avg < THIN_TEXT or pages <= SHORT_PDF:
            os.makedirs(out_dir, exist_ok=True)
            ts = int(time.time() * 1000)
            for i in range(min(pages, MAX_IMAGES)):
                pix = doc[i].get_pixmap(dpi=DPI)
                out = os.path.join(out_dir, "%d_pdf_p%d.png" % (ts, i + 1))
                pix.save(out)
                images.append(out)
        doc.close()
        if not text and not images:
            print(json.dumps({"error": "no text and no renderable pages"}))
            return 1
        print(json.dumps({"text": text, "images": images, "pages": pages},
                         ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001 - corrupt/encrypted pdf etc.
        print(json.dumps({"error": str(e)[:300]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
