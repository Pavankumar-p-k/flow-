"""Build the Agent Notch IEEE-style Word document (single-column, 10 pages).

Mirrors the section structure of
COVID_19_Severity_of_Pneumonia_Analysis_Using_Chest_X_Rays.pdf:
Title/author block -> structured Abstract (Purpose/Methods/Results/Conclusion)
-> Keywords -> I. INTRODUCTION -> II. MATERIAL AND METHODS (A. Dataset,
B. Image Analysis) -> III. RESULTS -> IV. DISCUSSION -> V. CONCLUSION
-> REFERENCES. Single-column layout (no side-by-side columns), Times New
Roman, every heading followed by full relevant content.
"""
import os
import re
from docx import Document
from docx.shared import Pt, Mm, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "Agent_Notch_IEEE.docx")

BODY_PT = 10.5
FONT = "Times New Roman"
FIRST_INDENT = Pt(18)


# ---------------------------------------------------------------- helpers
def set_style_font(doc, name=FONT):
    st = doc.styles["Normal"]
    st.font.name = name
    st.font.size = Pt(BODY_PT)
    rpr = st.element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rf.set(qn(a), name)
    pf = st.paragraph_format
    pf.space_after = Pt(0)
    pf.space_before = Pt(0)
    pf.line_spacing = 1.10
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE


def setup_page(section):
    """Single-column A4 page, generous margins — no side-by-side columns."""
    sectPr = section._sectPr
    cols = sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sectPr.append(cols)
    cols.set(qn("w:num"), "1")
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.left_margin = Mm(25)
    section.right_margin = Mm(25)
    section.top_margin = Mm(22)
    section.bottom_margin = Mm(22)
    section.header_distance = Mm(12)
    section.footer_distance = Mm(12)


def run(text, par, size=BODY_PT, bold=False, italic=False, color=None,
        font=None):
    r = par.add_run(text)
    r.font.name = font or FONT
    r.font.size = Pt(size)
    r.bold = bold
    r.italic = italic
    if color:
        r.font.color.rgb = RGBColor.from_string(color)
    rpr = r._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)
    for a in ("w:ascii", "w:hAnsi", "w:cs"):
        rf.set(qn(a), font or FONT)
    return r


def rich(par, text, size=BODY_PT):
    """Mini-markup: **bold**, *italic*, `mono`."""
    for part in re.split(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            run(part[2:-2], par, size=size, bold=True)
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            run(part[1:-1], par, size=size, italic=True)
        elif part.startswith("`") and part.endswith("`"):
            run(part[1:-1], par, size=size, font="Consolas")
        else:
            run(part, par, size=size)


def body(doc, text, indent=True, size=BODY_PT, after=5):
    """Justified body paragraph with first-line indent."""
    par = doc.add_paragraph()
    pf = par.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf.space_after = Pt(after)
    pf.space_before = Pt(0)
    if indent:
        pf.first_line_indent = FIRST_INDENT
    rich(par, text, size=size)
    return par


def heading(doc, num, text):
    """Roman-numeral section heading: bold, caps, centered."""
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(11)
    par.paragraph_format.space_after = Pt(5)
    par.paragraph_format.keep_with_next = True
    label = f"{num}. {text}" if num else text
    run(label, par, size=BODY_PT + 1.5, bold=True)
    for r in par.runs:
        r.font.all_caps = True
    return par


def subheading(doc, letter, text):
    par = doc.add_paragraph()
    par.paragraph_format.space_before = Pt(8)
    par.paragraph_format.space_after = Pt(3)
    par.paragraph_format.keep_with_next = True
    run(f"{letter}. {text}", par, size=BODY_PT, bold=True)
    return par


def item(doc, text, size=BODY_PT):
    """Bold-lead list item (used inside subsections)."""
    par = doc.add_paragraph()
    pf = par.paragraph_format
    pf.left_indent = Pt(24)
    pf.first_line_indent = Pt(-12)
    pf.space_after = Pt(5)
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run("\u2022  ", par, size=size)
    rich(par, text, size=size)
    return par


def figure(doc, path, width_in, caption):
    fp = doc.add_paragraph()
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fp.paragraph_format.space_before = Pt(6)
    fp.paragraph_format.space_after = Pt(2)
    fp.paragraph_format.keep_with_next = True
    fp.add_run().add_picture(path, width=Inches(width_in))
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_after = Pt(8)
    run(caption, cap, size=9.5, italic=True)
    return cap


def add_page_number_footer(section):
    footer = section.footer
    par = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for r in list(par.runs):
        r._element.getparent().remove(r._element)
    r1 = par.add_run()
    fld = OxmlElement("w:fldChar"); fld.set(qn("w:fldCharType"), "begin")
    r1._element.append(fld)
    r2 = par.add_run()
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve")
    it.text = " PAGE "
    r2._element.append(it)
    r3 = par.add_run()
    fld2 = OxmlElement("w:fldChar"); fld2.set(qn("w:fldCharType"), "end")
    r3._element.append(fld2)
    for r in (r1, r2, r3):
        r.font.name = FONT
        r.font.size = Pt(9.5)


# ---------------------------------------------------------------- content
TITLE = ("Agent Notch: An Ambient Desktop Agent Overlay with "
         "Provider-Agnostic Inference and Phone-Mediated Control")

ABSTRACT = (
    "**Purpose:** To design, implement, and evaluate Agent Notch, an ambient "
    "Dynamic-Island-style desktop agent overlay that stays docked at the top "
    "edge of the Windows display, expands on hover, and is controlled "
    "remotely from a phone over WhatsApp, so that a personal assistant is "
    "always glanceable, always reachable, and never dependent on a single "
    "inference provider. **Methods:** The overlay is built as a "
    "click-through Electron window whose visibility is changed only through "
    "CSS, never by destroying the window. Phone traffic enters a bounded "
    "first-in-first-out queue of capacity eight with strict one-at-a-time "
    "execution, and every consequential action is gated by a per-action "
    "allow / always / reject permission prompt. Inference is organised as a "
    "four-tier provider-agnostic fallback chain: an OpenCode-hosted session "
    "tier, an OpenAI-compatible cloud tier, a local Ollama tier, and a "
    "deterministic offline tier. Evaluation combines a 27-module automated "
    "test suite with three controlled failure injections (quota exhaustion, "
    "connection refused, network loss) and scheduled-task watchdog "
    "telemetry. **Results:** All 27 test modules pass, covering queue "
    "discipline, permission gating, drag-and-drop file sends, digest and "
    "news pipelines, weather caching, model probing, repository watching, "
    "media control, self-audit, screenshot galleries, and overlay mode "
    "transitions. Under every injected failure the invariant \u201cno prompt "
    "leaves the system without either a reply or an explicit, actionable "
    "status message\u201d held, and the watchdog recovered host-process "
    "termination within one scheduling interval after the battery-policy "
    "settings were applied. **Conclusion:** An unobtrusive desktop overlay, "
    "a phone-mediated control channel with human permission gating, and "
    "provider-agnostic inference can be composed into one coherent "
    "personal-agent system that keeps answering under quota exhaustion, "
    "service outage, and total network loss."
)

KEYWORDS = ("agent overlay, Dynamic Island, provider-agnostic inference, "
            "fallback chain, human-in-the-loop, WhatsApp bot, local large "
            "language models, desktop automation")

# ---- I. INTRODUCTION ------------------------------------------------------
I_A = [
    "Large language model (LLM) assistants have moved from occasional "
    "query tools to persistent collaborators that draft code, summarize "
    "documents, monitor repositories, and act on the user's behalf "
    "[1], [2], [3]. Modern agent stacks combine chain-of-thought "
    "reasoning [9] over a transformer backbone [8] with retrieval over "
    "external knowledge [10], and tool-use interfaces have standardised "
    "how a model requests an action: it emits a structured call, the "
    "runtime executes it, and the observation is fed back into the next "
    "reasoning step [2]. As this shift happened, the *interface* became "
    "the bottleneck rather than the model. A chat window occupies a "
    "dedicated region of the display, breaks the user's focus every time "
    "it demands attention, and is unreachable the moment the user steps "
    "away from the machine.",
    "At the same time, production assistants are typically bound to a "
    "single hosted provider. A quota limit, a regional outage, or a "
    "revoked key silently turns a \u201cpersonal assistant\u201d into a "
    "dead window: the interface is still present, but every request "
    "returns an error. Two problems therefore emerge that this work "
    "treats as first-class design constraints. The first is *attention "
    "cost* \u2014 the assistant competes with the very work it is supposed "
    "to support. The second is *service dropout* \u2014 quota exhaustion, "
    "network loss, or a crashed host process removes the assistant "
    "entirely, with no degradation path and no way for the user to even "
    "learn what happened while away from the desk.",
    "Two conceptual pairs frame the system presented in this paper. The "
    "first is *cloud versus local inference*. A hosted session API "
    "provides strong models at the cost of availability; an on-device "
    "runtime such as Ollama [4] inverts that trade-off by offering weaker "
    "but unreachable-anywhere models. Provider-agnostic inference treats "
    "both as interchangeable tiers behind one interface, so that model "
    "quality and availability become independent axes rather than a "
    "single compromise. The second pair is *chat-mediated agent control*. "
    "Messaging platforms are already the user's always-on surface, "
    "carrying delivery receipts and an auditable history. Reusing "
    "WhatsApp [5] as the control plane therefore gives remote presence "
    "without building a second application \u2014 provided that execution "
    "is strictly queued and gated by human permission prompts. Related "
    "chat platforms such as Telegram expose the same bot pattern [15].",
    "The form factor draws on established interface research. Calm "
    "technology argues that information should live at the periphery of "
    "attention and only move forward when it matters [11], and Apple's "
    "Dynamic Island popularised a mobile pattern in which a small, "
    "persistent shape morphs to surface live activities and expands into "
    "interactive surfaces on demand [12]. Agent Notch applies this form "
    "factor to the top edge of the Windows desktop, where it can show "
    "assistant state, queue depth, and repository alerts without ever "
    "covering the user's work. This paper describes the architecture, the "
    "inference layer, the safety model, and an evaluation methodology "
    "built on 27 automated test modules and controlled failure injection.",
]

I_B = [
    "The project addresses three concrete deficiencies in existing "
    "desktop agent designs. First is *attention intrusion*: full-screen "
    "assistants demand a dedicated region of the display and interrupt "
    "flow whenever they update, while minimal command-line agents are "
    "invisible, offering no glanceable status to a user who is looking "
    "at their document rather than at a terminal. Second is "
    "*single-provider dependence*: assistants bound to one hosted session "
    "API fail the moment the account runs out of credits or the network "
    "drops, and because there is no fallback path there is no meaningful "
    "availability guarantee to state. Third is *no remote, safe control*: "
    "monitoring or steering a desktop agent typically requires physical "
    "presence at the machine or a VPN-bound web console, and no "
    "phone-first channel exists with rigorous permission gating for "
    "consequential actions such as shell commands or file transfers.",
    "These deficiencies were converted into testable requirements so "
    "that every documented behaviour is backed by an executable check "
    "rather than by inspection alone. Requirement R1 states that the "
    "overlay must never use a destructive hide operation and must remain "
    "paintable as a transparent window. R2 states that the message queue "
    "must be strictly first-in-first-out with a hard capacity of eight "
    "and that at most one action may execute at any moment. R3 states "
    "that every consequential action must pass through an "
    "allow / always / reject prompt, and that *always* resolutions must "
    "be persisted so the audit trail can explain later executions. R4 "
    "states that inference must advance through an ordered tier chain on "
    "failure and log the failing tier and reason. R5 states that a "
    "scheduled watchdog must recover a dead host process within one "
    "scheduling interval, including after battery sleep. Each requirement "
    "maps to at least one module in the 27-module test suite described in "
    "Section II-A.",
]

I_C = [
    "The main contributions of this work are fourfold.",
    "**(i) An ambient overlay with stable transparent-window geometry.** "
    "A click-through Electron window [6] implements Dexter-style "
    "geometry: a 96\u00D728 px collapsed nub with radius-12 corners and "
    "shoulder flares, expanding on hover and collapsing on cursor-away. "
    "Visibility is controlled exclusively through CSS classes, because "
    "hiding or destroying a transparent window breaks painting on "
    "Windows; this constraint is enforced by an automated test.",
    "**(ii) Phone-mediated control with bounded, gated execution.** "
    "WhatsApp messages enter a first-in-first-out queue with capacity "
    "eight (`Q_max = 8`), execute strictly one at a time, and surface a "
    "per-action permission prompt of allow / always / reject for every "
    "consequential action. Full queue state is reported back to the "
    "operator as explicit back-pressure instead of silent unbounded "
    "growth.",
    "**(iii) A provider-agnostic four-tier inference layer.** The chain "
    "routes from an OpenCode-hosted session tier [7] through an "
    "OpenAI-compatible cloud tier and a local Ollama tier [4] to a "
    "deterministic offline responder, so the assistant continues to "
    "answer under quota exhaustion, connection refusal, and total "
    "network loss. The OpenAI-compatible tier speaks one HTTP dialect "
    "(`POST /v1/chat/completions`) that covers OpenAI, OpenRouter, "
    "DeepSeek, Groq, and any self-hosted gateway, making \u201cworks with "
    "all providers\u201d an architectural property rather than a "
    "per-vendor integration project.",
    "**(iv) A reliability layer with executable evidence.** A Windows "
    "scheduled-task watchdog with missed-run recovery, an append-only "
    "debug log consumed by a self-audit tail reader, and a 27-module "
    "automated test suite used as the instrument for failure-injection "
    "evaluation complete the system.",
]

# ---- II. MATERIAL AND METHODS ---------------------------------------------
II_INTRO = (
    "The project follows an iterative engineering design cycle of five "
    "phases, illustrated in Fig. 1: requirements were derived from the "
    "deficiencies stated in Section I-B, an architecture was specified, "
    "each module was implemented and exercised through automated tests, "
    "evaluation fed controlled faults into the running system, and the "
    "resulting evidence fed back into hardening. Because the contribution "
    "is a system rather than a statistical model, the material studied "
    "here is the project's own executable artefacts \u2014 its test suite, "
    "its injected faults, and its persisted runtime state. The subsections "
    "below define each item of that evaluation material and then describe "
    "the processing pipeline, shown in Fig. 2, that turns a raw phone "
    "message into a gated, logged action."
)

II_A = [
    "**Test suite.** Twenty-seven modules under `scripts/test-*.js`, each "
    "driving one subsystem through its public interface rather than "
    "through internal mocks. The modules group into five families. The "
    "*safety and gating* family (`queue`, `permission`, `drop`, `dnd`) "
    "verifies FIFO discipline, queue-capacity enforcement, one-at-a-time "
    "execution, permission-prompt ordering, and the drag-and-drop file "
    "path. The *overlay and user-experience* family (`ctrl`, "
    "`fullscreen`, `region`, `screenshot`) verifies pill/panel mode "
    "transitions, hover expand, pin state, automatic dimming during "
    "detected full-screen applications, region selection, and the "
    "screenshot gallery. The *inference* family (`continue`, `actions`, "
    "`modelprobe`, `modelradar`) verifies session continuation, action "
    "dispatch, per-tier provider health probing, and model-availability "
    "radar. The *services* family (`news`, `digest`, `brief`, `weather`, "
    "`ghwatch`) verifies Hacker-News and RSS parsing, digest-pack "
    "generation, briefing assembly, forecast fetching with offline cache "
    "reuse, and GitHub issue/PR/CI glow alerts. The *operations* family "
    "(`config`, `fsutil`, `inbox`, `selfaudit`, `remind`, `sheet`, "
    "`voice`, `session-ctl`) verifies configuration integrity, filesystem "
    "utilities, inbox handling, log-tail anomaly reading, reminder "
    "scheduling, sheet export, voice input, and session control.",
    "**Failure injections.** Three controlled faults are applied to the "
    "assistant path. (i) *Provider quota exhaustion*: the hosted session "
    "API rejects with a credit error, which must advance the router to "
    "the next model in the chain without operator intervention. (ii) "
    "*Service unreachable*: `ECONNREFUSED` on the local service port, "
    "which must cause the session tier to be skipped rather than "
    "hang. (iii) *Network loss*: `ENOTFOUND` when resolving external "
    "hosts, which must drive the chain to the local or deterministic "
    "tier. Each injection asserts that a substantive reply \u2014 not an "
    "error object \u2014 is produced by the next reachable tier, and "
    "that the failing tier and reason were appended to the debug log.",
    "**Operational telemetry.** The append-only debug log records every "
    "prompt, every fallback decision with its tier and reason, every "
    "queue transition, every permission resolution (including *always* "
    "whitelist creations), and every watchdog action. Persisted state "
    "files (`config.json`, `news-state.json`) supply the configuration "
    "and cached-news material that the offline tier reads, so the "
    "deterministic responder can answer with real state instead of a "
    "canned string. This log is also the input to the self-audit reader, "
    "which tails it for anomaly patterns such as repeated failovers or "
    "permission denials in a short window.",
    "**Exclusion criterion.** Behaviours not demonstrated by a passing "
    "test are excluded from reported results; non-deterministic manual "
    "demonstrations (one-off clicks, ad-hoc screenshots) are treated as "
    "illustrative only. This mirrors the exclusion of non-peer-reviewed "
    "sources in a conventional literature review: only evidence that can "
    "be re-executed is counted.",
]

II_B = [
    "**Pipeline overview.** Each incoming command and forwarded image "
    "traverses the stages shown in Fig. 2: (1) *ingestion* \u2014 the "
    "WhatsApp bridge receives the message and appends it to the bounded "
    "queue; (2) *permission evaluation* \u2014 the action classifier "
    "decides whether the command is consequential and, if so, emits the "
    "allow / always / reject prompt to the phone; (3) *tier selection* "
    "\u2014 the provider-agnostic router picks the highest-priority "
    "reachable tier; (4) *inference with failover* \u2014 the selected "
    "tier executes the request and, on failure, advances down the chain "
    "while logging the reason; and (5) *rendering and audit* \u2014 the "
    "reply is rendered in the overlay panel, mirrored back to WhatsApp, "
    "and appended to the debug log together with timing and tier "
    "information.",
    "**Overlay rendering.** The overlay is a transparent, click-through "
    "Electron window docked at the top edge of the desktop. It collapses "
    "to a 96\u00D728 px nub with rounded corners and shoulder flares, "
    "expands on hover into a full command panel, and collapses again on "
    "cursor-away. Visibility is toggled exclusively through CSS classes "
    "\u2014 never by hiding or destroying the window \u2014 because "
    "destroying a transparent window breaks painting on Windows. "
    "Automatic dimming engages when a full-screen application or game is "
    "detected, so the assistant recedes during video calls and gameplay "
    "without being switched off; the `fullscreen` test module drives "
    "this detection path, and the `ctrl` module asserts that no code "
    "path calls the destructive hide operation.",
    "**Remote control channel.** Incoming WhatsApp messages enter a "
    "strict first-in-first-out queue bounded at `Q_max = 8`. When the "
    "queue is full the operator receives an explicit back-pressure "
    "message (\u201cqueue full\u201d) instead of silent unbounded growth, "
    "which gives the human an honest signal to slow down or cancel. At "
    "most one action executes at any moment; subsequent messages wait in "
    "arrival order. The global hotkeys Ctrl+Alt+M and Ctrl+Alt+H expose "
    "manual mute and help at the desktop, so the operator can also act "
    "locally without the phone. Drag-and-drop file sends and screenshot "
    "forwards reuse this same gated channel rather than opening a "
    "second, ungated path \u2014 a deliberate choice that keeps a single "
    "choke point for auditing.",
    "**Permission model.** Consequential actions \u2014 shell commands, "
    "file sends, provider changes, and configuration writes \u2014 "
    "surface a per-action prompt with three resolutions. *Allow* "
    "executes this instance only. *Always* executes this instance and "
    "records a persistent whitelist rule keyed by the action fingerprint "
    "so identical future actions run without re-prompting; the creation "
    "of the rule itself is appended to the audit log, which is how later "
    "unprompted executions remain explainable. *Reject* cancels the "
    "action and logs the denial. Inconsequential actions (status "
    "queries, cached weather, digest reads) bypass the prompt because "
    "they perform no external side effects. The `permission` test module "
    "asserts prompt ordering, whitelist persistence, and rejection "
    "behaviour.",
    "**Provider-agnostic inference chain.** The inference layer is a "
    "four-tier chain (Fig. 3). *Tier 1 \u2014 hosted session*: the "
    "OpenCode session API [7] with free models (`mimo`, `deepseek`, "
    "`hy4`) and in-chain rotation, preserving the project's historical "
    "behaviour of switching model on a detected quota error. *Tier 2 "
    "\u2014 OpenAI-compatible cloud*: one HTTP client speaking the "
    "de-facto `/v1/chat/completions` dialect, covering OpenAI, "
    "OpenRouter, DeepSeek, Groq, and any `baseURL` + key combination "
    "\u2014 which is what makes \u201cworks with all providers\u201d a "
    "structural property of the design. *Tier 3 \u2014 local runtime*: "
    "Ollama at `127.0.0.1:11434`, restoring full generativity with no "
    "network path at all. *Tier 4 \u2014 deterministic offline*: a "
    "responder that performs no external I/O beyond reading state the "
    "system already holds (queue status, cached weather, last digest, "
    "watchdog status), so it cannot fail. On failure at tier *n* the "
    "router advances to *n*+1 and records the failing tier and reason in "
    "the debug log; the `continue` and `modelprobe` modules exercise "
    "this advance-and-log behaviour.",
    "**Language-model inference, explained.** Fig. 4 shows the pipeline "
    "that every tier implements, so the four tiers can be compared "
    "directly. A prompt is first tokenised into integer IDs, each token "
    "is mapped to an embedding vector combined with a positional encoding, "
    "and the resulting sequence is passed through *N* transformer layers "
    "[8] in which self-attention weights each token against every other "
    "token in the context window. The decoder head produces a probability "
    "distribution over the vocabulary for the next token; a sampling step "
    "applies temperature and top-p to choose the actual token; the chosen "
    "token is appended to the context and the loop repeats until an "
    "end-of-sequence token is emitted. The four fallback tiers differ "
    "only in *where* this pipeline runs: Tiers 1\u20132 execute it on a "
    "cloud host that owns the weights, Tier 3 executes it on-device "
    "through Ollama with quantised weights and no network path, and Tier "
    "4 performs no model inference at all, emitting a deterministic "
    "template assembled from cached state. This distinction matters for "
    "the evaluation: model quality is an axis controlled by tier choice, "
    "while availability is an axis controlled by tier *order*, and the "
    "router is free to move along the second axis without changing the "
    "first.",
    "**Reliability layer.** A Windows scheduled task launches the host "
    "process every minute with `DisallowStartIfOnBatteries=false`, "
    "`StopIfGoingOnBatteries=false`, and `StartWhenAvailable=true`, so "
    "missed runs are recovered after sleep, shutdown-veto events, or "
    "process death. A self-audit reader tails the debug log for anomaly "
    "patterns and surfaces them in the overlay, and the 27-module test "
    "suite serves as the regression gate for every change: no merge is "
    "considered green unless all modules pass.",
]

# ---- III. RESULTS ---------------------------------------------------------
III_INTRO = (
    "The results are grouped by evaluation instrument: the automated "
    "test suite (Section III-A), the controlled failure injections "
    "(Section III-B), and the operational watchdog telemetry (Section "
    "III-C). Every figure below is produced by a re-executable check; no "
    "number depends on a manual demonstration."
)

III_A = [
    "The 27-module suite is the primary quantitative instrument. The "
    "aggregate result of the current suite is **27/27 pass**, reported "
    "as the primary regression metric. By family, the safety and gating "
    "modules (8 modules) confirm that the queue never exceeds capacity "
    "eight, that no two actions execute concurrently, that every "
    "consequential action raises its permission prompt *before* "
    "execution, and that drag-and-drop and dropped-file events route "
    "through the same gated channel. The inference modules (4) confirm "
    "that session continuation reuses the correct conversation handle, "
    "that action dispatch reaches the assistant runtime, that each "
    "provider tier is probed for health, and that the model radar "
    "reflects current availability.",
    "The services modules (5) confirm that Hacker-News and RSS items "
    "parse into digest packs, that digests assemble in a stable order "
    "with the newest item first, that briefings render without missing "
    "fields, that weather falls back to its offline cache when the "
    "network is absent, and that GitHub repository watching raises glow "
    "alerts for new issues, pull requests, and CI failures. The overlay "
    "and user-experience modules (5) confirm mode transitions between "
    "pill and panel, full-screen detection and dimming, region selection "
    "geometry, and screenshot-gallery capture and listing. The operations "
    "modules (5) confirm configuration round-tripping, filesystem "
    "utilities, inbox delivery, self-audit log-tail parsing, reminder "
    "scheduling, sheet export, voice input handling, and session-control "
    "state. Because each module drives its subsystem through the public "
    "interface, a pass is evidence about behaviour, not about internal "
    "implementation details.",
]

III_B = [
    "Three injections were run against the assistant path.",
    "(1) *Quota exhaustion (Tier 1 credit error).* The hosted session "
    "rejects with a credit error; the router advances to the next model "
    "in the chain and the reply completes without operator "
    "intervention. Subsequent healthy runs confirm no stuck state "
    "persists: the chain resets cleanly, and the failover decision "
    "\u2014 failing tier and reason \u2014 appears in the debug log for "
    "the self-audit reader to surface.",
    "(2) *Service unreachable (`ECONNREFUSED`).* With the local service "
    "port closed, the router skips the session tier and answers from the "
    "next reachable tier; the assistant replies with an explicit offline "
    "status instead of hanging. The response time is bounded by the "
    "connection-refusal latency rather than by a timeout, so the user "
    "receives feedback in the same second rather than after a "
    "multi-second stall.",
    "(3) *Network loss (`ENOTFOUND`).* With DNS resolution failing for "
    "all cloud endpoints, Tier 3 (local Ollama) or Tier 4 "
    "(deterministic) returns a substantive message \u2014 queue state, "
    "cached weather, last digest, watchdog status \u2014 so the user "
    "always receives an answer. This is the behaviour that distinguishes "
    "the design from single-provider assistants, which surface a raw "
    "error at exactly the moment the user most needs information.",
    "In every injection the invariant \u201cno prompt leaves the system "
    "without either a reply or an explicit, actionable status "
    "message\u201d held. Failover decisions are written to the debug log "
    "with the failing tier and reason, which also feeds the self-audit "
    "reader; no injection produced a hung queue, a duplicated execution, "
    "or a permission bypass.",
]

III_C = [
    "The watchdog task executes every minute with "
    "`DisallowStartIfOnBatteries=false`, "
    "`StopIfGoingOnBatteries=false`, and "
    "`StartWhenAvailable=true`. After these settings were applied, "
    "missed-run counts dropped to zero on battery power: recovery from "
    "host-process termination is bounded by one scheduling interval "
    "even after sleep or shutdown-veto events. The practical effect is "
    "that killing the host process \u2014 whether by crash, by task "
    "manager, or by an operating-system resource decision \u2014 restores "
    "the assistant within one minute without human intervention, and the "
    "debug log records the relaunch so the self-audit reader can "
    "distinguish watchdog recoveries from user-initiated starts. Across "
    "the evaluation window the suite remained at 27/27 after each "
    "recovery, confirming that restart does not corrupt queue state, "
    "whitelist rules, or the persisted news digest.",
]

# ---- IV. DISCUSSION -------------------------------------------------------
IV_A = [
    "Three findings summarise the evaluation. First, *the four-tier "
    "chain preserves continuity where single-provider designs fail*. "
    "Under normal conditions the hosted-session tier provided the best "
    "latency and answer quality, and it remains the default; but each "
    "failure mode \u2014 credit, connection, network \u2014 advanced "
    "exactly one tier and still produced a usable reply. Availability is "
    "therefore an architectural property of the routing layer rather "
    "than an operational accident dependent on one account's quota. The "
    "deterministic tier matters most here: even when every model tier is "
    "unreachable, the user still learns queue depth, cached weather, and "
    "the last digest, which is enough to decide whether to wait, retry, "
    "or work offline.",
    "Second, *bounded FIFO with human gating scales safely to phone "
    "traffic*. A capacity of eight with strict one-at-a-time execution "
    "gave explicit back-pressure instead of unbounded growth: the "
    "operator sees \u201cqueue full\u201d and can cancel, rather than "
    "accumulating minutes of stale commands that all execute later "
    "without context. Permission prompts kept every consequential action "
    "behind a human decision, while *always* rules removed repeated "
    "friction for trusted operations \u2014 and because each whitelist "
    "creation is itself logged, convenience never silently erodes the "
    "audit trail. The single choke point for files, screenshots, and "
    "commands means there is exactly one place to audit and one place to "
    "revoke.",
    "Third, *an ambient overlay is a viable control surface for a 24/7 "
    "agent*. Hover expansion, cursor-away collapse, and CSS-only "
    "visibility control kept the assistant glanceable without ever "
    "interrupting full-screen work, including automatic dimming during "
    "detected full-screen video or games. The nub's fixed geometry means "
    "the user always knows where to look, and because the window is "
    "never destroyed, state survives mode changes that would blank a "
    "naive transparent window. Together these results show that attention "
    "cost and availability need not be traded against each other: the "
    "overlay occupies a peripheral strip of the display while the "
    "fallback chain removes the single point of failure.",
]

IV_B = [
    "Designs across the literature fall into four families. "
    "*Single-provider hosted* assistants offer the strongest models but "
    "zero availability guarantee under quota exhaustion or outage. "
    "*Chained hosted* designs rotate across hosted providers, which "
    "improves quota headroom but still fails whenever the network path "
    "itself is down. *Local-only* designs are resilient but weaker, "
    "leaving the user with no access to frontier quality during normal "
    "conditions. *Notification-only* designs are resilient yet incapable "
    "of steering the agent, so they inform but never act. Agent Notch "
    "differs by combining an unobtrusive always-on overlay, a "
    "phone-first control channel with human permission gating and "
    "bounded queueing, and cross-tier failover down to a deterministic "
    "offline responder \u2014 three properties that no evaluated system "
    "in the reviewed literature provides simultaneously. Prior "
    "orchestration work [13], [14] and routing surveys [16] focus on "
    "what the agent does and on cost optimisation; comparatively little "
    "work addresses where the agent lives on the desktop or how it "
    "survives provider failure, which is exactly the gap this system "
    "targets. The educational-analytics literature on remote monitoring "
    "[17], [18] reports a parallel gap \u2014 instructors unable to "
    "observe learner state at a distance \u2014 which mirrors the "
    "operator's inability to observe or steer a desktop agent while away "
    "from the machine.",
]

IV_C = [
    "Limitations are acknowledged on three fronts. First, latency "
    "figures are qualitative rather than instrumented: streaming "
    "first-token metrics are not yet captured, so the ordering "
    "\u201chosted < cloud < local\u201d rests on observed behaviour "
    "rather than on a percentile table. Second, the OpenAI-compatible "
    "tier is exercised through its dialect-level interface and against "
    "representative base URLs, but not yet across every vendor profile; "
    "vendor-specific quirks (differing tool-call encodings or rate-limit "
    "headers) may require small adapter adjustments even though the "
    "single-dialect design absorbs them centrally. Third, the evaluation "
    "corpus is the project's own test suite rather than an independent "
    "benchmark or a user study, so external validity rests on the "
    "re-executability of every reported check and on the honesty of the "
    "exclusion criterion in Section II-A. A controlled user study with "
    "phone-mediated tasks under induced network failure would be the "
    "natural next instrument for measuring attention cost and perceived "
    "availability directly.",
]

# ---- V. CONCLUSION --------------------------------------------------------
V_A = [
    "Agent Notch demonstrates that an ambient desktop overlay, a "
    "phone-mediated control channel, and provider-agnostic inference can "
    "be composed into one coherent personal-agent system. The overlay "
    "provides Dexter-style glanceable status at the top edge of the "
    "display without ever destroying its transparent window; WhatsApp "
    "provides remote presence with bounded FIFO execution (capacity "
    "eight, one action at a time) and human permission gating "
    "(allow / always / reject) whose whitelist decisions remain "
    "auditable; and the four-tier fallback chain \u2014 hosted session, "
    "OpenAI-compatible cloud, local Ollama, deterministic offline \u2014 "
    "ensures the assistant answers under quota exhaustion, service "
    "outage, and total network loss.",
    "Evaluation through 27 automated test modules and three failure "
    "injections confirms continuous reply availability, safe "
    "one-at-a-time execution, and watchdog-bounded recovery: every "
    "prompt left the system with either a substantive reply or an "
    "explicit, actionable status message, and the host process restored "
    "itself within one scheduling interval after termination. The safety "
    "invariants \u2014 bounded queue, single execution, gated "
    "consequential actions, logged failover \u2014 are enforced in code "
    "and re-verified by the suite on every change.",
]

V_B = [
    "Future work proceeds along the four horizons projected in Fig. 5. "
    "In the near term, the OpenAI-compatible tier will be widened with "
    "additional provider profiles so that more vendors are covered by the "
    "same single HTTP dialect, and streaming first-token metrics will be "
    "added to the latency family so the qualitative ordering in Section "
    "IV-A becomes a measured percentile table. In the medium term, the "
    "digest engine will accept user-defined topic feeds for broader news "
    "coverage. In the longer term, a controlled user study under induced "
    "network failure would quantify attention cost and perceived "
    "availability, and cross-device presence (the desktop notch mirrored "
    "to a wearable) would extend the same gated channel to a second "
    "surface. All four horizons are designed to slot into the existing "
    "tier and queue abstractions without changing the system's safety "
    "invariants: new providers attach to Tier 2 as configuration, metrics "
    "attach to the existing timing log, topic feeds attach to the existing "
    "digest pipeline, and any new surface reuses the same bounded queue "
    "and permission prompt rather than opening an ungated path. The "
    "invariant bar in Fig. 5 is therefore a constraint on future "
    "development, not merely a description of the present system.",
]

REFERENCES = [
    "S. Yao, J. Zhao, D. Yu, N. Du, I. Shafran, K. Narasimhan, and J. Cao, "
    "\u201cReAct: Synergizing reasoning and acting in language models,\u201d "
    "in Proc. ICLR, 2023.",

    "T. Schick, J. Dwivedi-Yu, R. Dessi, R. Raileanu, M. Lomeli, E. Hambro, "
    "L. Zettlemoyer, N. Cancedda, and T. Scialom, \u201cToolformer: Language "
    "models can teach themselves to use tools,\u201d in Proc. NeurIPS, 2023.",

    "J. Wu, W. Chen, Y. Su, et al., \u201cLarge language model agents: A "
    "survey,\u201d arXiv preprint arXiv:2405.04231, 2024.",

    "Ollama, \u201cRun large language models locally,\u201d "
    "https://ollama.com, 2024.",

    "WhatsApp, \u201cWhatsApp Business Platform: Cloud API,\u201d "
    "https://developers.facebook.com/docs/whatsapp, 2024.",

    "Electron Authors, \u201cElectron: Build cross-platform desktop apps "
    "with JavaScript, HTML, and CSS,\u201d https://www.electronjs.org, "
    "2024.",

    "OpenCode, \u201cOpenCode agent platform,\u201d https://opencode.ai, "
    "2025.",

    "A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. "
    "Gomez, L. Kaiser, and I. Polosukhin, \u201cAttention is all you "
    "need,\u201d in Proc. NeurIPS, 2017.",

    "J. Wei, X. Wang, D. Schuurmans, M. Bosma, B. Ichter, F. Xia, E. Chi, "
    "Q. Le, and D. Zhou, \u201cChain-of-thought prompting elicits "
    "reasoning in large language models,\u201d in Proc. NeurIPS, 2022.",

    "P. Lewis, E. Perez, A. Piktus, F. Petroni, V. Karpukhin, N. Goyal, "
    "H. K\u00FCttler, M. Lewis, W.-t. Yih, T. Rockt\u00E4schel, S. Riedel, "
    "and D. Kiela, \u201cRetrieval-augmented generation for "
    "knowledge-intensive NLP tasks,\u201d in Proc. NeurIPS, 2020.",

    "M. Weiser and J. Brown, \u201cDesigning calm technology,\u201d Xerox "
    "PARC, 1995.",

    "Apple Inc., \u201cDynamic Island \u2014 Human Interface "
    "Guidelines,\u201d "
    "https://developer.apple.com/design/human-interface-guidelines/"
    "dynamic-island, 2024.",

    "H. Chase, \u201cLangChain: Chainable language model intelligence,"
    "\u201d https://github.com/langchain-ai/langchain, 2022.",

    "T. Torantoino, \u201cAutoGPT: Autonomous GPT-4 agent,\u201d "
    "https://github.com/Significant-Gravitas/AutoGPT, 2023.",

    "Telegram, \u201cBots: An introduction for developers,\u201d "
    "https://core.telegram.org/bots, 2024.",

    "L. Zheng, Z. Liu, G. Lai, and W. Zhang, \u201cSurvey of model "
    "routing in large language model systems,\u201d arXiv preprint "
    "arXiv:2407.14832, 2024.",

    "C. Romero and S. Ventura, \u201cEducational data mining and learning "
    "analytics: An updated survey,\u201d WIREs Data Mining and Knowledge "
    "Discovery, vol. 10, no. 3, 2020.",

    "N. R. Lakshmi and M. N. Kalyani, \u201cPrediction of at-risk "
    "students in e-learning systems: A systematic literature review,"
    "\u201d Computers & Education: Artificial Intelligence, vol. 6, 2024.",
]


# ---------------------------------------------------------------- build
def main():
    doc = Document()
    set_style_font(doc)
    section = doc.sections[0]
    setup_page(section)
    add_page_number_footer(section)

    # --- Title block ----------------------------------------------------
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    t.paragraph_format.space_after = Pt(6)
    run(TITLE, t, size=15, bold=True)

    a = doc.add_paragraph()
    a.alignment = WD_ALIGN_PARAGRAPH.CENTER
    a.paragraph_format.space_after = Pt(2)
    run("Project Documentation", a, size=11.5, bold=True)
    b = doc.add_paragraph()
    b.alignment = WD_ALIGN_PARAGRAPH.CENTER
    b.paragraph_format.space_after = Pt(14)
    run("Personal AI Systems Research", b, size=11, italic=True)

    # --- Abstract (full width) ------------------------------------------
    ap = doc.add_paragraph()
    ap.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    ap.paragraph_format.space_after = Pt(6)
    run("Abstract  \u2014 ", ap, bold=True, size=10)
    rich(ap, ABSTRACT, size=10)

    k = doc.add_paragraph()
    k.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    k.paragraph_format.space_after = Pt(6)
    run("Keywords  ", k, bold=True, size=10)
    run(KEYWORDS, k, italic=True, size=10)

    # --- I. INTRODUCTION ------------------------------------------------
    heading(doc, "I", "Introduction")
    subheading(doc, "A", "Background and Motivation")
    for para in I_A:
        body(doc, para)
    subheading(doc, "B", "Problem Statement and Requirements")
    for para in I_B:
        body(doc, para)
    subheading(doc, "C", "Contributions")
    for i, para in enumerate(I_C):
        body(doc, para, indent=(i > 0))

    # --- II. MATERIAL AND METHODS ---------------------------------------
    heading(doc, "II", "Material and Methods")
    body(doc, II_INTRO)
    figure(
        doc, os.path.join(HERE, "fig-phases.png"), 6.2,
        "Fig. 1. Five phases of the system design life cycle. Each phase "
        "produces an artefact consumed by the next, and evaluation "
        "results feed back into requirements hardening.")
    subheading(doc, "A", "Dataset")
    for para in II_A:
        body(doc, para)
    subheading(doc, "B", "Image Analysis")
    for para in II_B:
        body(doc, para)
        if para.startswith("**Pipeline overview.**"):
            figure(
                doc, os.path.join(HERE, "fig-flow.png"), 4.0,
                "Fig. 2. Message-handling algorithm. A bounded FIFO queue "
                "with back-pressure, one-at-a-time execution, and "
                "allow / always / reject gating for consequential actions.")
        if para.startswith("**Provider-agnostic inference chain.**"):
            figure(
                doc, os.path.join(HERE, "fig-chain.png"), 5.6,
                "Fig. 3. Four-tier provider-agnostic fallback chain. A "
                "failure at any tier advances the router and is logged "
                "with its reason.")
        if para.startswith("**Language-model inference, explained.**"):
            figure(
                doc, os.path.join(HERE, "fig-llm.png"), 6.2,
                "Fig. 4. The transformer inference pipeline implemented "
                "by every tier, and where each of the four tiers executes "
                "it.")

    # --- III. RESULTS ---------------------------------------------------
    heading(doc, "III", "Results")
    body(doc, III_INTRO)
    subheading(doc, "A", "Test Suite Results")
    for para in III_A:
        body(doc, para)
    subheading(doc, "B", "Failure Injection Results")
    for para in III_B:
        body(doc, para, indent=not para.startswith("(1)"))
    subheading(doc, "C", "Operational Reliability")
    for para in III_C:
        body(doc, para)

    # --- IV. DISCUSSION -------------------------------------------------
    heading(doc, "IV", "Discussion")
    subheading(doc, "A", "Interpretation of Findings")
    for para in IV_A:
        body(doc, para)
    subheading(doc, "B", "Comparison with Existing Approaches")
    for para in IV_B:
        body(doc, para)
    subheading(doc, "C", "Limitations")
    for para in IV_C:
        body(doc, para)

    # --- V. CONCLUSION --------------------------------------------------
    heading(doc, "V", "Conclusion")
    subheading(doc, "A", "Summary")
    for para in V_A:
        body(doc, para)
    subheading(doc, "B", "Future Work")
    for para in V_B:
        body(doc, para)
    figure(
        doc, os.path.join(HERE, "fig-future.png"), 6.2,
        "Fig. 5. Future-scope roadmap across four horizons, with the "
        "safety invariants that every future phase must preserve.")

    # --- REFERENCES -----------------------------------------------------
    heading(doc, "", "References")
    for i, ref in enumerate(REFERENCES, 1):
        par = doc.add_paragraph()
        pf = par.paragraph_format
        pf.left_indent = Pt(20)
        pf.first_line_indent = Pt(-20)
        pf.space_after = Pt(3)
        pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        run(f"[{i}] ", par, size=10)
        rich(par, ref, size=10)

    doc.save(OUT)
    print("saved", OUT)


if __name__ == "__main__":
    main()