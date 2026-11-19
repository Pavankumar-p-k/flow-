"""Voice-note transcription for the notch (item 7).

Reads an audio path (WhatsApp voice notes are opus/ogg; ffmpeg-free thanks to
faster-whisper's bundled audio decoder via PyAV), transcribes with
large-v3-turbo (multilingual — the user's notes are Telugu/English mix),
prints one JSON line: {"text": "..."} or {"error": "..."}.

Run: python scripts/transcribe.py <audio-path>
"""
import json
import sys

MODEL = "large-v3-turbo"   # multilingual; auto-detects Telugu vs English per note
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        # int8 on CPU: fast enough for short notes, ~1.6GB RAM while loaded
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    return _model


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <audio-path>"}))
        return 1
    path = sys.argv[1]
    try:
        model = get_model()
        segments, info = model.transcribe(
            path,
            vad_filter=True,               # drop silence so short notes are quick
            beam_size=5,
            # language=None -> auto-detect (Telugu vs English per note)
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        print(json.dumps({
            "text": text,
            "language": getattr(info, "language", ""),
            "duration": round(getattr(info, "duration", 0.0), 1),
        }, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001 - surface any failure as JSON
        print(json.dumps({"error": str(e)[:300]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
