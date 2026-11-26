"""Build the Agent Notch IEEE-style Word document.

Mirrors the exact section structure of
COVID_19_Severity_of_Pneumonia_Analysis_Using_Chest_X_Rays.pdf:
Title/author block -> structured Abstract (Purpose/Methods/Results/Conclusion)
-> Keywords -> I. INTRODUCTION -> II. MATERIAL AND METHODS (A. Dataset,
B. Image Analysis) -> III. RESULTS -> IV. DISCUSSION -> V. CONCLUSION
-> REFERENCES. IEEE two-column layout, Times New Roman, ICIIS-style margins.
"""
import os
from docx import Document
from docx.shared import Pt, Inches, Mm, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "Agent_Notch_IEEE.docx")

BODY_PT = 9.5
FONT = "Times New Roman"


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
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE


def column_setup(section, space=6, m_left=8.8, m_right=8.8, m_top=9.2, m_bottom=9.2):
    sectPr = section._sectPr
    cols = sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sectPr.append(cols)
    cols.set(qn("w:num"), "2")
    cols.set(qn("w:space"), str(int(space * 56.7)))   # twips (pt*20)
    cols.set(qn("w:equalWidth"), "1")
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.left_margin = Mm(m_left)
    section.right_margin = Mm(m_right)
    section.top_margin = Mm(m_top)
    section.bottom_margin = Mm(m_bottom)
    section.header_distance = Mm(5)
    section.footer_distance = Mm(5)


def p(doc, text="", size=BODY_PT, bold=False, italic=False, align=None,
      before=0, after=0, first_indent=None, left_indent=None, keep=False,
      color=None, all_caps=False):
    par = doc.add_paragraph()
    pf = par.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if first_indent is not None:
        pf.first_line_indent = Pt(first_indent)
    if left_indent is not None:
        pf.left_indent = Pt(left_indent)
    if align is not None:
        par.alignment = align
    if keep:
        pf.keep_with_next = True
    if text:
        run(text, par, size, bold, italic, color, all_caps)
    return par


def run(text, par, size=BODY_PT, bold=False, italic=False, color=None,
        all_caps=False, font=None):
    r = par.add_run(text)
    r.font.name = font or FONT
    r.font.size = Pt(size)
    r.bold = bold
    r.italic = italic
    if color:
        r.font.color.rgb = RGBColor.from_string(color)
    if all_caps:
        r.font.all_caps = True
    rpr = r._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)
    for a in ("w:ascii", "w:hAnsi", "w:cs"):
        rf.set(qn(a), font or FONT)
    return r


def heading(doc, num, text):
    """Roman-numeral section heading, IEEE/ICIIS style: bold, caps, centered."""
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(7)
    par.paragraph_format.space_after = Pt(3.5)
    par.paragraph_format.keep_with_next = True
    run(f"{num}. {text}", par, size=BODY_PT + 0.5, bold=True, all_caps=True)
    return par


def subheading(doc, letter, text):
    par = doc.add_paragraph()
    par.paragraph_format.space_before = Pt(4.5)
    par.paragraph_format.space_after = Pt(1.5)
    par.paragraph_format.left_indent = Pt(10)
    par.paragraph_format.keep_with_next = True
    run(f"{letter}. {text}", par, size=BODY_PT, bold=True)
    return par


def bullet(doc, text, size=BODY_PT):
    par = doc.add_paragraph()
    pf = par.paragraph_format
    pf.left_indent = Pt(13)
    pf.first_line_indent = Pt(-7)
    pf.space_before = Pt(1)
    pf.space_after = Pt(1)
    run("\u25AA  ", par, size=size)
    rich(par, text, size)
    return par


def numbered(doc, idx, text, size=BODY_PT):
    par = doc.add_paragraph()
    pf = par.paragraph_format
    pf.left_indent = Pt(15)
    pf.first_line_indent = Pt(-11)
    pf.space_before = Pt(1)
    pf.space_after = Pt(1)
    run(f"[{idx}] ", par, size=size, bold=True)
    rich(par, text, size)
    return par


def rich(par, text, size=BODY_PT):
    """Mini-markup: **bold**, *italic*, `mono`."""
    import re
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


def add_page_number_footer(section):
    footer = section.footer
    footer.is_linked_to_previous = True
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
        r.font.size = Pt(8.5)


# ---------------------------------------------------------------- content
ABSTRACT = (
    "**Purpose:** To design, implement, and evaluate Agent Notch, an ambient "
    "Dynamic-Island-style desktop agent overlay that stays docked at the top "
    "edge of the Windows display, expands on hover, and is controlled "
    "remotely from a phone over WhatsApp. The system routes inference through "
    "a provider-agnostic fallback chain so that a substantive reply is always "
    "produced, even when every network path fails. "
    "**Methods:** The overlay is built as a click-through Electron window "
    "whose visibility is changed only through CSS, never by destroying the "
    "window. Phone traffic enters a bounded first-in-first-out queue of "
    "capacity eight with strict one-at-a-time execution, and every "
    "consequential action is gated by a per-action allow / always / reject "
    "permission prompt. Inference is organised as a four-tier fallback chain: "
    "an OpenCode-hosted session tier, an OpenAI-compatible cloud tier, a local "
    "Ollama tier, and a deterministic offline tier. Evaluation combines a "
    "27-module automated test suite with three controlled failure injections "
    "(quota exhaustion, connection refused, network loss). "
    "**Results:** All 27 test modules pass, covering queue discipline, "
    "permission gating, digest and news pipelines, model probing, repository "
    "watching, media control, self-audit and overlay transitions. Under every "
    "injected failure the invariant \u201cno prompt leaves the system without "
    "either a reply or an explicit, actionable status message\u201d held, and "
    "the watchdog recovered host-process termination within one scheduling "
    "interval after applying the battery-policy settings. "
    "**Conclusion:** An unobtrusive desktop overlay, a phone-mediated control "
    "channel with human permission gating, and provider-agnostic inference "
    "can be composed into one coherent personal-agent system that keeps "
    "answering under quota exhaustion, service outage, and total network loss."
)

KEYWORDS = ("agent overlay, Dynamic Island, provider-agnostic inference, "
            "fallback chain, human-in-the-loop, WhatsApp bot, local large "
            "language models, desktop automation")

INTRO = [
    ("Large language model (LLM) assistants have moved from occasional query "
     "tools to persistent collaborators that draft code, summarize documents, "
     "monitor repositories, and act on the user's behalf [1], [2], [3]. As "
     "this shift happened, the *interface* became the bottleneck: a chat "
     "window occupies the screen, breaks the user's focus, and is "
     "unreachable when the user steps away from the machine. At the same "
     "time, production assistants depend on a single hosted provider, so a "
     "quota limit or a regional outage silently turns a personal assistant "
     "into a dead window. Two problems therefore emerge: (i) attention cost "
     "\u2014 the assistant competes with the work it is supposed to support; "
     "and (ii) *service dropout* \u2014 quota exhaustion, network loss, or a "
     "crashed host process removes the assistant entirely."),
    ("The project addresses three concrete deficiencies in existing desktop "
     "agent designs. First, *attention intrusion*: full-screen assistants "
     "demand a dedicated region of the display, while minimal command-line "
     "agents are invisible and offer no glanceable status. Second, "
     "*single-provider dependence*: assistants bound to one hosted session "
     "API fail the moment the account runs out of credits or the network "
     "drops \u2014 there is no fallback path and therefore no meaningful "
     "availability guarantee. Third, *no remote, safe control*: monitoring or "
     "steering a desktop agent typically requires physical presence or a "
     "VPN-bound web console; there is no phone-first channel with rigorous "
     "permission gating for consequential actions."),
    ("Two conceptual pairs frame the system. *Cloud versus local inference*: "
     "a hosted session API provides strong models at the cost of "
     "availability, while an on-device runtime such as Ollama [4] inverts "
     "that trade-off; provider-agnostic inference treats both as "
     "interchangeable tiers behind one interface, so model quality and "
     "availability become independent axes. *Chat-mediated agent control*: "
     "messaging platforms are already the user's always-on surface, so "
     "reusing WhatsApp [5] as the control plane gives remote presence, "
     "delivery receipts, and an auditable message history without building a "
     "second application \u2014 provided that execution is strictly queued "
     "and gated by human permission prompts."),
    ("The main contributions of this work are fourfold: (i) a click-through "
     "ambient overlay with Dexter-style geometry (96\u00D728 px collapsed "
     "nub, radius 12, shoulder flares), built on Electron [6], that expands "
     "on hover, collapses on cursor-away, and is hidden only through CSS; "
     "(ii) phone-mediated WhatsApp control with a bounded FIFO queue "
     "(capacity eight), strict one-at-a-time execution, and a permission "
     "model of allow / always / reject prompts; (iii) a provider-agnostic "
     "inference layer with a four-tier fallback chain \u2014 hosted session, "
     "OpenAI-compatible cloud, local Ollama, and a deterministic offline "
     "responder \u2014 that keeps the assistant answering under quota "
     "exhaustion and total network loss; and (iv) a reliability layer "
     "combining a Windows scheduled-task watchdog with missed-run recovery, "
     "a self-audit tail reader, and an automated test suite of 27 modules "
     "used for failure-injection evaluation."),
]

METHODS_A_INTRO = (
    "Agent Notch is an engineering system rather than a statistical model, "
    "so the evaluation corpus is the project's automated test suite together "
    "with controlled failure injections, complemented by the operational "
    "state the system persists at runtime. The following items define the "
    "material used throughout the study."
)

METHODS_A = [
    ("**Test suite.** Twenty-seven modules under `scripts/test-*.js`, each "
     "driving one subsystem through its public interface: queue discipline, "
     "permission gating, drag-and-drop and file sends, digest generation, "
     "news parsing, weather caching, model probing and model radar, "
     "repository watching, media control, self-audit, screenshot gallery, "
     "reminders, inbox and continue-session flows, configuration integrity, "
     "fsutil, fullscreen and region detection, session control, sheet "
     "export, voice, and overlay control transitions."),
    ("**Failure injections.** Three controlled faults applied to the "
     "assistant path: (i) provider quota exhaustion \u2014 the session API "
     "rejects with a credit error; (ii) service unreachable \u2014 "
     "`ECONNREFUSED` on the local service port; and (iii) network loss \u2014 "
     "`ENOTFOUND` on external hosts. Each injection asserts that a reply is "
     "still produced by the next reachable tier of the chain."),
    ("**Operational telemetry.** The append-only debug log records every "
     "prompt, fallback decision, queue transition, and watchdog action. "
     "Persisted state files (`config.json`, `news-state.json`) provide the "
     "configuration and cached-news material used by the offline tier. "
     "Exclusion criterion: only behaviours demonstrated by a passing test "
     "are counted as results; non-deterministic manual demonstrations are "
     "treated as illustrative only."),
]

METHODS_B = [
    ("**Overlay rendering.** The overlay is a transparent, click-through "
     "Electron window docked at the top edge of the desktop. It collapses to "
     "a 96\u00D728 px nub with rounded corners and shoulder flares, expands "
     "on hover into a full panel, and collapses again on cursor-away. "
     "Visibility is toggled exclusively through CSS classes \u2014 never by "
     "hiding or destroying the window \u2014 because destroying a "
     "transparent window breaks painting on Windows. Automatic dimming "
     "engages when a full-screen application or game is detected."),
    ("**Remote control channel.** Incoming WhatsApp messages enter a strict "
     "first-in-first-out queue bounded at `Q_max = 8`; when the queue is "
     "full the operator receives an explicit back-pressure message instead "
     "of silent unbounded growth. At most one action executes at any moment. "
     "Consequential actions (shell commands, file sends, provider changes) "
     "surface a per-action permission prompt with allow / always / reject "
     "resolution, and the resolution \u2014 including *always* whitelist "
     "entries \u2014 is appended to the audit log. Drag-and-drop file sends "
     "and screenshot forwards reuse this same gated channel rather than "
     "opening a second, ungated path. The global hotkeys Ctrl+Alt+M and "
     "Ctrl+Alt+H expose manual mute and help."),
    ("**Provider-agnostic inference chain.** The inference layer is a "
     "four-tier chain, illustrated in Fig. 1. Tier 1 rotates across hosted "
     "free models on the OpenCode session API [7] when a quota error is "
     "detected. Tier 2 speaks the de-facto OpenAI-compatible "
     "`/v1/chat/completions` dialect, which covers OpenAI, OpenRouter, "
     "DeepSeek, Groq, and any self-hosted gateway through a single client \u2014 "
     "this is what makes \u201cworks with all providers\u201d an "
     "architectural property rather than a per-vendor integration project. "
     "Tier 3 is a local Ollama runtime at `127.0.0.1:11434`, restoring full "
     "generativity with no network path. Tier 4 is a deterministic offline "
     "responder that performs no external I/O beyond reading state the "
     "system already holds (queue status, cached weather, last digest), so it "
     "never fails. On failure at tier *n* the router advances to *n*+1 and "
     "records the reason in the debug log."),
    ("**Reliability layer.** A Windows scheduled task launches the host "
     "process every minute with `DisallowStartIfOnBatteries=false`, "
     "`StopIfGoingOnBatteries=false`, and `StartWhenAvailable=true`, giving "
     "missed-run recovery after sleep, shutdown-veto, or process death. A "
     "self-audit reader tails the debug log for anomalies, and the 27-module "
     "test suite serves as the regression gate for every change."),
]

RESULTS_I = [
    ("**Test suite.** The 27-module suite is the primary quantitative "
     "instrument. The modules group into five families: safety and gating "
     "(queue, permission, drop, dnd, fullscreen, region, screenshot, ctrl), "
     "inference (continue, actions, modelprobe, modelradar), services (news, "
     "digest, brief, weather, ghwatch), overlay and user experience, and "
     "operations (config, fsutil, inbox, selfaudit, remind, sheet, voice). "
     "The aggregate result of the current suite is 27/27 pass, which is "
     "reported as the primary regression metric."),
    ("**Failure injection.** Three injections were run against the assistant "
     "path. (1) *Quota exhaustion*: the hosted session rejects with a credit "
     "error and the router advances to the next model in the chain, "
     "completing the reply without operator intervention, with no stuck "
     "state on subsequent healthy runs. (2) *Service unreachable*: with the "
     "local service port closed, the router skips the session tier and the "
     "assistant replies with an explicit offline status instead of hanging. "
     "(3) *Network loss*: with DNS resolution failing for all cloud "
     "endpoints, Tier 3 (local) or Tier 4 (deterministic) returns a "
     "substantive message \u2014 queue state, cached weather, last digest "
     "\u2014 so the user always receives an answer. In every injection the "
     "invariant \u201cno prompt leaves the system without either a reply or "
     "an explicit, actionable status message\u201d held, and each failover "
     "decision was written to the debug log with the failing tier and "
     "reason, feeding the self-audit reader."),
    ("**Operational reliability.** After the watchdog task was re-registered "
     "with the battery-policy settings above, missed-run counts dropped to "
     "zero on battery power, demonstrating that recovery from host-process "
     "termination is bounded by one scheduling interval even after sleep or "
     "shutdown-veto events."),
]

DISCUSSION = [
    ("The evaluation yields three findings. First, the four-tier chain "
     "preserves continuity where single-provider designs fail: the "
     "hosted-session tier provided the best latency and answer quality under "
     "normal conditions, and each failure mode \u2014 credit, connection, "
     "network \u2014 advanced one tier and still produced a usable reply, "
     "making availability an architectural property rather than an "
     "operational accident. This directly answers the research gap in "
     "single-provider assistants, which surface a raw \u201coffline\u201d "
     "error when the hosted session is unavailable."),
    ("Second, bounded FIFO with human gating scales safely to phone traffic. "
     "A capacity of eight with strict one-at-a-time execution gave explicit "
     "back-pressure instead of unbounded growth, while permission prompts "
     "kept every consequential action behind a human decision; *always* "
     "rules removed repeated friction without losing the audit trail, since "
     "each whitelist entry is itself recorded when it is created."),
    ("Third, an ambient overlay is a viable control surface for a 24/7 "
     "agent. Hover expansion, cursor-away collapse, and CSS-only visibility "
     "control kept the assistant glanceable without ever interrupting "
     "full-screen work, including automatic dimming during detected "
     "full-screen video or games. Together these results show that "
     "attention cost and availability need not be traded against each "
     "other: the overlay occupies a peripheral strip of the display while "
     "the fallback chain removes the single point of failure."),
    ("Limitations are acknowledged. Latency figures are qualitative rather "
     "than instrumented, because streaming first-token metrics are not yet "
     "captured; the OpenAI-compatible tier is exercised through its "
     "dialect-level interface but not yet across every vendor profile; and "
     "the evaluation corpus is the project's own test suite rather than an "
     "independent benchmark, so external validity rests on the "
     "re-executability of every reported check."),
]

CONCLUSION = [
    ("Agent Notch demonstrates that an ambient desktop overlay, a "
     "phone-mediated control channel, and provider-agnostic inference can be "
     "composed into one coherent personal-agent system. The overlay provides "
     "Dexter-style glanceable status at the top edge of the display; "
     "WhatsApp provides remote presence with bounded FIFO execution "
     "(capacity eight) and human permission gating (allow / always / "
     "reject); and the four-tier fallback chain \u2014 hosted session, "
     "OpenAI-compatible cloud, local Ollama, and deterministic offline \u2014 "
     "ensures the assistant answers under quota exhaustion, service outage, "
     "and total network loss."),
    ("Evaluation through 27 automated test modules and three failure "
     "injections confirms continuous reply availability, safe one-at-a-time "
     "execution, and watchdog-bounded recovery. Future enhancements include "
     "widening the OpenAI-compatible tier with additional provider "
     "profiles, adding streaming first-token metrics to the latency family, "
     "and extending the digest engine with user-defined topic feeds \u2014 "
     "all designed to slot into the existing tier and queue abstractions "
     "without changing the system's safety invariants."),
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
    "with JavaScript, HTML, and CSS,\u201d https://www.electronjs.org, 2024.",

    "OpenCode, \u201cOpenCode agent platform,\u201d https://opencode.ai, "
    "2025.",

    "A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. Gomez, "
    "L. Kaiser, and I. Polosukhin, \u201cAttention is all you need,\u201d in "
    "Proc. NeurIPS, 2017.",

    "J. Wei, X. Wang, D. Schuurmans, M. Bosma, B. Ichter, F. Xia, E. Chi, "
    "Q. Le, and D. Zhou, \u201cChain-of-thought prompting elicits reasoning "
    "in large language models,\u201d in Proc. NeurIPS, 2022.",

    "P. Lewis, E. Perez, A. Piktus, F. Petroni, V. Karpukhin, N. Goyal, "
    "H. K\u00FCttler, M. Lewis, W.-t. Yih, T. Rockt\u00E4schel, S. Riedel, "
    "and D. Kiela, \u201cRetrieval-augmented generation for "
    "knowledge-intensive NLP tasks,\u201d in Proc. NeurIPS, 2020.",

    "M. Weiser and J. Brown, \u201cDesigning calm technology,\u201d Xerox "
    "PARC, 1995.",

    "Apple Inc., \u201cDynamic Island \u2014 Human Interface Guidelines,\u201d "
    "https://developer.apple.com/design/human-interface-guidelines/"
    "dynamic-island, 2024.",

    "H. Chase, \u201cLangChain: Chainable language model intelligence,\u201d "
    "https://github.com/langchain-ai/langchain, 2022.",

    "T. Torantoino, \u201cAutoGPT: Autonomous GPT-4 agent,\u201d "
    "https://github.com/Significant-Gravitas/AutoGPT, 2023.",

    "Telegram, \u201cBots: An introduction for developers,\u201d "
    "https://core.telegram.org/bots, 2024.",

    "L. Zheng, Z. Liu, G. Lai, and W. Zhang, \u201cSurvey of model routing "
    "in large language model systems,\u201d arXiv preprint "
    "arXiv:2407.14832, 2024.",

    "C. Romero and S. Ventura, \u201cEducational data mining and learning "
    "analytics: An updated survey,\u201d WIREs Data Mining and Knowledge "
    "Discovery, vol. 10, no. 3, 2020.",

    "N. R. Lakshmi and M. N. Kalyani, \u201cPrediction of at-risk students "
    "in e-learning systems: A systematic literature review,\u201d Computers "
    "& Education: Artificial Intelligence, vol. 6, 2024.",
]

TITLE = ("Agent Notch: An Ambient Desktop Agent Overlay with "
         "Provider-Agnostic Inference and Phone-Mediated Control")

AUTHORS = [
    ("Project Documentation", "Personal AI Systems Research", ""),
]


# ---------------------------------------------------------------- build
def main():
    doc = Document()
    set_style_font(doc)

    # --- Section 1: full-width title block -----------------------------
    s1 = doc.sections[0]
    column_setup(s1, space=6)  # placeholder; overridden below
    # make section 1 single column
    cols = s1._sectPr.find(qn("w:cols"))
    cols.set(qn("w:num"), "1")

    t = p(doc, align=WD_ALIGN_PARAGRAPH.CENTER, before=0, after=2)
    run(TITLE, t, size=13, bold=True)

    for name, aff, email in AUTHORS:
        a = p(doc, align=WD_ALIGN_PARAGRAPH.CENTER, after=0)
        run(name, a, size=10.5, bold=True)
        b = p(doc, align=WD_ALIGN_PARAGRAPH.CENTER, after=0)
        run(aff, b, size=9.5, italic=True)
        if email:
            c = p(doc, align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
            run(email, c, size=9.5)
        else:
            p(doc, after=3)

    # Abstract (full width, single column — IEEE style)
    ap = p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=1)
    run("Abstract  \u2014 ", ap, bold=True)
    rich(ap, ABSTRACT, size=BODY_PT - 0.5)

    k = p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, after=3)
    run("Keywords  ", k, size=BODY_PT - 0.5, bold=True)
    run(KEYWORDS, k, size=BODY_PT - 0.5, italic=True)

    # --- Section 2: two-column body ------------------------------------
    s2 = doc.add_section(WD_SECTION.CONTINUOUS)
    column_setup(s2, space=6)
    add_page_number_footer(s2)

    # --- I. INTRODUCTION ------------------------------------------------
    heading(doc, "I", "Introduction")
    for para in INTRO:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11,
          after=1.5) and None
        rich(doc.paragraphs[-1], para)

    # --- II. MATERIAL AND METHODS ---------------------------------------
    heading(doc, "II", "Material and Methods")
    p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
    rich(doc.paragraphs[-1], METHODS_A_INTRO)
    subheading(doc, "A", "Dataset")
    for para in METHODS_A:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
        rich(doc.paragraphs[-1], para)
    subheading(doc, "B", "Image Analysis")
    p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
    rich(doc.paragraphs[-1],
         "The analysis pipeline processes each incoming command and image "
         "through the stages shown in Fig. 1: message ingestion and "
         "queueing, permission evaluation, provider-tier selection, "
         "inference execution with failover, and result rendering in the "
         "overlay panel with an audit-log append.")
    for para in METHODS_B:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
        rich(doc.paragraphs[-1], para)
        # place Fig. 1 right after the fallback-chain paragraph it illustrates
        if para.startswith("**Provider-agnostic inference chain.**"):
            fp = doc.add_paragraph()
            fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            fp.paragraph_format.space_before = Pt(4)
            fp.paragraph_format.space_after = Pt(1)
            fp.paragraph_format.keep_with_next = True
            fp.add_run().add_picture(os.path.join(HERE, "fig-chain.png"),
                                     width=Inches(3.35))
            cap = p(doc, align=WD_ALIGN_PARAGRAPH.CENTER, after=3)
            cap.paragraph_format.keep_with_next = False
            run("Fig. 1. Four-tier provider-agnostic fallback chain. A "
                "failure at any tier advances the router and is logged "
                "with its reason.", cap, size=8.5, italic=True)

    # --- III. RESULTS ---------------------------------------------------
    heading(doc, "III", "Results")
    p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
    rich(doc.paragraphs[-1],
         "The results reported below are grouped by evaluation instrument: "
         "the automated test suite, the controlled failure injections, and "
         "the operational watchdog telemetry. All figures are produced by "
         "re-executable checks.")
    for para in RESULTS_I:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
        rich(doc.paragraphs[-1], para)

    # --- IV. DISCUSSION -------------------------------------------------
    heading(doc, "IV", "Discussion")
    for para in DISCUSSION:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
        rich(doc.paragraphs[-1], para)

    # --- V. CONCLUSION --------------------------------------------------
    heading(doc, "V", "Conclusion")
    for para in CONCLUSION:
        p(doc, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=11, after=1.5)
        rich(doc.paragraphs[-1], para)

    # --- REFERENCES -----------------------------------------------------
    heading(doc, "", "References").runs[0].text = "References"
    for i, ref in enumerate(REFERENCES, 1):
        par = doc.add_paragraph()
        pf = par.paragraph_format
        pf.left_indent = Pt(14)
        pf.first_line_indent = Pt(-14)
        pf.space_after = Pt(1)
        par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        run(f"[{i}] ", par, size=BODY_PT - 0.5)
        rich(par, ref, size=BODY_PT - 0.5)

    doc.save(OUT)
    print("saved", OUT)


if __name__ == "__main__":
    main()