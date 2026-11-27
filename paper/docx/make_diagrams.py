"""Generate all diagrams for the Agent Notch IEEE Word document.

Outputs (in this folder):
  fig-chain.png    Fig. 1 - four-tier fallback chain
  fig-phases.png   Fig. 2 - system design phases
  fig-flow.png     Fig. 3 - message handling algorithm (flowchart)
  fig-llm.png      Fig. 4 - LLM inference pipeline explanation
  fig-future.png   Fig. 5 - future scope roadmap
"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

HERE = os.path.dirname(os.path.abspath(__file__))


def new_fig(w, h):
    fig, ax = plt.subplots(figsize=(w, h), dpi=300)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")
    return fig, ax


def rbox(ax, x, y, w, h, text, fc="#dbeafe", ec="#1d4ed8", fs=7.5,
         bold=False, rounding=3.0, lw=1.2):
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle=f"round,pad=0.4,rounding_size={rounding}",
                         linewidth=lw, edgecolor=ec, facecolor=fc, zorder=2)
    ax.add_patch(box)
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, zorder=3, linespacing=1.3,
            fontweight="bold" if bold else "normal", color="#111827")


def diamond(ax, cx, cy, w, h, text, fc="#fef9c3", ec="#a16207", fs=7.0):
    pts = [(cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2),
           (cx - w / 2, cy)]
    poly = plt.Polygon(pts, closed=True, linewidth=1.2, edgecolor=ec,
                       facecolor=fc, zorder=2)
    ax.add_patch(poly)
    ax.text(cx, cy, text, ha="center", va="center", fontsize=fs, zorder=3,
            color="#111827", linespacing=1.2)


def arrow(ax, p1, p2, color="#374151", lw=1.3, style="-|>", ls="-",
          rad=0.0, label=None, lpos=0.5, lfs=6.5, lcolor="#374151"):
    a = FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=11,
                        linewidth=lw, color=color, linestyle=ls,
                        connectionstyle=f"arc3,rad={rad}", zorder=1)
    ax.add_patch(a)
    if label:
        mx = p1[0] + (p2[0] - p1[0]) * lpos
        my = p1[1] + (p2[1] - p1[1]) * lpos
        ax.text(mx, my, label, fontsize=lfs, color=lcolor, ha="center",
                va="center", zorder=4,
                bbox=dict(fc="white", ec="none", pad=0.6))


def save(fig, name):
    out = os.path.join(HERE, name)
    fig.savefig(out, bbox_inches="tight", facecolor="white", pad_inches=0.06)
    plt.close(fig)
    print("saved", out)


# ---------------------------------------------------------------- Fig 1
def fig_chain():
    tiers = [
        ("Tier 1 - Hosted Session API",
         "OpenCode free models (mimo, deepseek, hy4)\nwith in-chain rotation",
         "#dbeafe", "#1d4ed8"),
        ("Tier 2 - OpenAI-Compatible Cloud",
         "OpenRouter / DeepSeek / Groq / any baseURL + key\n"
         "(one /v1/chat/completions dialect)",
         "#e0f2fe", "#0369a1"),
        ("Tier 3 - Local Runtime",
         "Ollama at 127.0.0.1:11434\n(quantized on-device models)",
         "#dcfce7", "#15803d"),
        ("Tier 4 - Deterministic Offline",
         "Status, cached weather/news, queue state\n(no I/O - never fails)",
         "#fef9c3", "#a16207"),
    ]
    fails = ["4xx / credit error", "5xx / timeout", "no daemon"]
    fig, ax = new_fig(6.6, 5.6)
    w, h = 80, 16
    x = 10
    ys = [80, 57, 34, 11]
    for (title, sub, fc, ec), y in zip(tiers, ys):
        rbox(ax, x, y, w, h, "", fc=fc, ec=ec, rounding=3.5)
        ax.text(x + w / 2, y + h * 0.66, title, ha="center", va="center",
                fontsize=8.6, fontweight="bold", color="#111827", zorder=3)
        ax.text(x + w / 2, y + h * 0.26, sub, ha="center", va="center",
                fontsize=6.8, color="#374151", zorder=3, linespacing=1.3)
    for i, label in enumerate(fails):
        y0, y1 = ys[i], ys[i + 1]
        arrow(ax, (x + w / 2, y0 - 0.5), (x + w / 2, y1 + h + 0.5),
              color="#6b7280", ls="--", label=label, lpos=0.5, lfs=6.6,
              lcolor="#4b5563")
    ax.text(50, 3,
            "Failure at any tier advances the router; reason is logged "
            "to the audit tail",
            ha="center", va="center", fontsize=6.6, color="#6b7280",
            style="italic")
    save(fig, "fig-chain.png")


# ---------------------------------------------------------------- Fig 2
def fig_phases():
    phases = [
        ("Phase 1", "Requirements", "Deficiencies I-B ->\ntestable claims R1-R5", "#dbeafe", "#1d4ed8"),
        ("Phase 2", "Architecture", "Overlay, queue, tiers,\naudit designed", "#e0f2fe", "#0369a1"),
        ("Phase 3", "Implementation", "Electron overlay, bridge,\nrouters, watchdog", "#dcfce7", "#15803d"),
        ("Phase 4", "Verification", "27 automated test\nmodules (regression)", "#fef9c3", "#a16207"),
        ("Phase 5", "Evaluation", "3 failure injections +\nwatchdog telemetry", "#ede9fe", "#6d28d9"),
    ]
    fig, ax = new_fig(9.6, 3.0)
    w, h, gap = 16.5, 46, 3.4
    y = 30
    for i, (ph, name, sub, fc, ec) in enumerate(phases):
        x = 2 + i * (w + gap)
        rbox(ax, x, y, w, h, "", fc=fc, ec=ec, rounding=3.0)
        ax.text(x + w / 2, y + h * 0.80, ph, ha="center", va="center",
                fontsize=8.0, fontweight="bold", color="#111827", zorder=3)
        ax.text(x + w / 2, y + h * 0.60, name, ha="center", va="center",
                fontsize=8.6, fontweight="bold", color="#111827", zorder=3)
        ax.text(x + w / 2, y + h * 0.28, sub, ha="center", va="center",
                fontsize=6.6, color="#374151", zorder=3, linespacing=1.35)
        if i < len(phases) - 1:
            arrow(ax, (x + w + 0.4, y + h / 2), (x + w + gap - 0.4, y + h / 2),
                  color="#374151", lw=1.5)
    # feedback arrow: evaluation -> requirements (hardening loop)
    x_last = 2 + 4 * (w + gap) + w / 2
    x_first = 2 + w / 2
    ax.plot([x_last, x_last, x_first, x_first], [y - 0.5, 16, 16, y - 0.5],
            color="#6b7280", lw=1.1, linestyle="--", zorder=1)
    arrow(ax, (x_first, 16), (x_first, y - 0.5), color="#6b7280", lw=1.1,
          ls="--", label="hardening feedback", lpos=0.5, lfs=6.6,
          lcolor="#6b7280")
    save(fig, "fig-phases.png")


# ---------------------------------------------------------------- Fig 3
def fig_flow():
    """Message-handling algorithm: spine on the left, decision
    side-branches on the right, merged outcome boxes at the bottom."""
    fig, ax = new_fig(6.8, 8.0)
    ax.set_xlim(-3, 101)
    ax.set_ylim(0, 121)
    C = 30            # spine centre x
    XE = 48           # spine right edge
    XS = 12           # spine left edge
    BW = XE - XS      # spine box width (36)
    BH = 8            # box height
    DW, DH = 38, 10    # diamond size
    R = 58            # side-branch column x

    def node(y, text, fc="#dbeafe", ec="#1d4ed8", fs=7.2, bold=False):
        rbox(ax, XS, y, BW, BH, text, fc=fc, ec=ec, fs=fs, bold=bold,
             rounding=BH / 2)

    def ask(cy, text, fs=6.7):
        diamond(ax, C, cy, DW, DH, text, fs=fs)

    def down(y_top, y_bot, label=None, lfs=6.3, lx=-5):
        arrow(ax, (C, y_top), (C, y_bot))
        if label:
            ax.text(C + lx, (y_top + y_bot) / 2, label, fontsize=lfs,
                    color="#374151", ha="right" if lx < 0 else "left",
                    va="center")

    # ---- spine rows (y = box bottom) ----
    node(110, "WhatsApp message arrives", fc="#f1f5f9", ec="#334155",
         fs=7.5, bold=True)                       # 110-118
    ask(103.5, "Queue full?\n(len >= 8)")          # 98.5-108.5
    down(110, 108.5)
    node(88, "Enqueue (strict FIFO,\ncapacity 8)")  # 88-96
    down(98.5, 96, label="no")
    ask(81, "Worker idle?\n(one-at-a-time)")        # 76-86
    down(88, 86)
    node(64.5, "Dequeue head action\n(one-at-a-time)")  # 64.5-72.5
    down(76, 72.5, label="yes")
    ask(57.5, "Consequential\naction?")             # 52.5-62.5
    down(64.5, 62.5)
    node(41, "Prompt phone:\nALLOW / ALWAYS / REJECT",
         fc="#fef9c3", ec="#a16207", fs=7.0)        # 41-49
    down(52.5, 49, label="yes")
    ask(34.5, "Resolution?")                        # 29.5-39.5
    down(41, 39.5)

    # ---- side branch: queue full -> reject (right) ----
    arrow(ax, (XE, 103.5), (R + 19, 103.5), label="yes", lpos=0.35)
    rbox(ax, R, 93, 38, 10, "Reject: reply\n'queue full' (back-pressure)",
         fc="#fee2e2", ec="#b91c1c", fs=6.8, rounding=3.0)
    arrow(ax, (R + 19, 103.5), (R + 19, 103))

    # ---- side branch: worker not idle -> wait loop (left) ----
    arrow(ax, (XS, 81), (3, 81), label="no", lpos=0.45, lfs=6.3)
    ax.plot([3, 3], [81, 92], color="#374151", lw=1.2, zorder=1)
    arrow(ax, (3, 92), (XS, 92))
    ax.text(3, 86.5, "wait", fontsize=6.1, color="#6b7280",
            ha="center", va="center", style="italic", zorder=4,
            bbox=dict(fc="white", ec="none", pad=0.4))

    # ---- side branch: not consequential -> bypass prompt (left) ----
    # merges into the "always" channel, then into the execute box
    arrow(ax, (XS, 57.5), (4, 57.5), label="no", lpos=0.45, lfs=6.3)
    ax.plot([4, 4], [57.5, 34.5], color="#374151", lw=1.2, zorder=1)

    # ---- resolution exits ----
    # allow -> down into execute box
    arrow(ax, (C, 29.5), (C, 27), label="allow", lpos=0.5, lfs=6.2)
    # always -> left, down, into execute box
    arrow(ax, (XS, 34.5), (4, 34.5), label="always", lpos=0.4, lfs=6.1)
    ax.plot([4, 4], [34.5, 22], color="#374151", lw=1.2, zorder=1)
    arrow(ax, (4, 22), (6, 22))
    # reject -> right, down, into cancel box
    arrow(ax, (XE, 34.5), (76, 34.5), label="reject", lpos=0.4, lfs=6.2)
    ax.plot([76, 76], [34.5, 27], color="#374151", lw=1.2, zorder=1)
    arrow(ax, (76, 27), (76, 27))

    # ---- outcome boxes ----
    rbox(ax, 6, 17, 40, 10,
         "ALLOW / ALWAYS ->\nexecute action, record *always* rule",
         fc="#dcfce7", ec="#15803d", fs=6.8, rounding=3.0)
    rbox(ax, 56, 17, 40, 10, "REJECT -> cancel\n+ log denial",
         fc="#fee2e2", ec="#b91c1c", fs=6.8, rounding=3.0)
    # execute + cancel -> audit/notify
    arrow(ax, (26, 17), (26, 13))
    arrow(ax, (76, 17), (76, 13))
    rbox(ax, 6, 3, 90, 10,
         "Append audit log (reply, tier, timing) + notify phone "
         "and overlay panel",
         fc="#f1f5f9", ec="#334155", fs=7.0, bold=True, rounding=3.0)

    save(fig, "fig-flow.png")


# ---------------------------------------------------------------- Fig 4
def fig_llm():
    """LLM inference pipeline: how a prompt becomes a reply, and where
    the four tiers differ."""
    fig, ax = new_fig(8.6, 5.4)
    ax.set_ylim(0, 106)

    # --- pipeline stages (left to right) ---
    stages = [
        ("Prompt", "phone text /\ncommand", "#f1f5f9", "#334155"),
        ("Tokenizer", "text -> token\nIDs", "#e0f2fe", "#0369a1"),
        ("Embedding", "token + position\nvectors", "#e0f2fe", "#0369a1"),
        ("Transformer\nlayers", "self-attention x N\n(LLM weights)", "#dbeafe", "#1d4ed8"),
        ("Decoder", "next-token\nprobabilities", "#dbeafe", "#1d4ed8"),
        ("Sampling", "temperature /\ntop-p", "#ede9fe", "#6d28d9"),
        ("Reply", "streamed to\noverlay + phone", "#dcfce7", "#15803d"),
    ]
    w, h, gap = 12.0, 24, 2.2
    y = 58
    xs = []
    for i, (name, sub, fc, ec) in enumerate(stages):
        x = 1.5 + i * (w + gap)
        xs.append(x)
        rbox(ax, x, y, w, h, "", fc=fc, ec=ec, rounding=2.6)
        ax.text(x + w / 2, y + h * 0.70, name, ha="center", va="center",
                fontsize=7.4, fontweight="bold", color="#111827", zorder=3,
                linespacing=1.15)
        ax.text(x + w / 2, y + h * 0.28, sub, ha="center", va="center",
                fontsize=6.2, color="#374151", zorder=3, linespacing=1.3)
        if i > 0:
            arrow(ax, (x - gap + 0.3, y + h / 2), (x - 0.3, y + h / 2),
                  color="#374151", lw=1.4)
    ax.text(50, 97, "Autoregressive decoding loop (repeat until <EOS>)",
            ha="center", fontsize=7.0, color="#6b7280", style="italic")
    # loop-back arrow over the top of transformer -> decoder chain
    lx0 = xs[3] + w / 2
    lx1 = xs[4] + w / 2
    ax.plot([lx1, lx1, lx0, lx0], [y + h + 3, y + h + 8, y + h + 8,
                                   y + h + 3],
            color="#6d28d9", lw=1.1, linestyle="--", zorder=1)
    arrow(ax, (lx0, y + h + 8), (lx0, y + h + 3.2), color="#6d28d9",
          lw=1.1, ls="--")

    # --- where tiers differ ---
    ax.text(50, 44, "The four fallback tiers swap WHERE this pipeline runs:",
            ha="center", fontsize=7.4, fontweight="bold", color="#111827")
    tiers = [
        ("Tier 1-2: cloud", "API host runs the weights\n(model quality best,\nneeds network)", "#dbeafe", "#1d4ed8"),
        ("Tier 3: local", "Ollama runs quantized\nweights on-device\n(no network needed)", "#dcfce7", "#15803d"),
        ("Tier 4: offline", "no model at all -\ndeterministic template\nfrom cached state", "#fef9c3", "#a16207"),
    ]
    tw, th = 27, 24
    ty = 8
    for i, (name, sub, fc, ec) in enumerate(tiers):
        tx = 6 + i * (tw + 5)
        rbox(ax, tx, ty, tw, th, "", fc=fc, ec=ec, rounding=2.8)
        ax.text(tx + tw / 2, ty + th * 0.76, name, ha="center", va="center",
                fontsize=7.4, fontweight="bold", color="#111827", zorder=3)
        ax.text(tx + tw / 2, ty + th * 0.32, sub, ha="center", va="center",
                fontsize=6.3, color="#374151", zorder=3, linespacing=1.35)
        # connector up to the pipeline band
        arrow(ax, (tx + tw / 2, ty + th + 0.6), (tx + tw / 2, y - 3.5),
              color="#9ca3af", lw=1.0, ls=":")
    save(fig, "fig-llm.png")


# ---------------------------------------------------------------- Fig 5
def fig_future():
    fig, ax = new_fig(9.4, 3.6)
    ax.set_ylim(0, 112)
    # roadmap timeline
    ax.annotate("", xy=(97, 66), xytext=(3, 66),
                arrowprops=dict(arrowstyle="-|>", color="#334155", lw=2.0))
    items = [
        ("Now", "Ship multi-provider\ntier + offline tier",
         "provider profiles for\nOpenAI-compatible tier", "#dbeafe", "#1d4ed8"),
        ("Next", "Streaming metrics",
         "first-token latency per\ntier added to test suite",
         "#e0f2fe", "#0369a1"),
        ("Later", "Digest topic feeds",
         "user-defined RSS/HN\ntopics in news engine",
         "#dcfce7", "#15803d"),
        ("Future", "Cross-device + study",
         "wearable mirror of notch,\ncontrolled user study",
         "#ede9fe", "#6d28d9"),
    ]
    w, h = 21, 34
    y = 72
    for i, (tag, title, sub, fc, ec) in enumerate(items):
        x = 3 + i * 24.2
        # milestone dot on timeline
        ax.plot([x + w / 2], [66], marker="o", ms=6.5, color=ec, zorder=3)
        ax.plot([x + w / 2, x + w / 2], [66, y - 0.5], color="#9ca3af",
                lw=1.0, linestyle=":", zorder=1)
        rbox(ax, x, y, w, h, "", fc=fc, ec=ec, rounding=2.6)
        ax.text(x + w / 2, y + h * 0.78, tag, ha="center", va="center",
                fontsize=7.2, fontweight="bold", color=ec, zorder=3)
        ax.text(x + w / 2, y + h * 0.55, title, ha="center", va="center",
                fontsize=7.6, fontweight="bold", color="#111827", zorder=3,
                linespacing=1.15)
        ax.text(x + w / 2, y + h * 0.22, sub, ha="center", va="center",
                fontsize=6.3, color="#374151", zorder=3, linespacing=1.35)
        ax.text(x + w / 2, 57, f"Q{i + 1}", ha="center", fontsize=6.6,
                color="#6b7280")
    # invariant bar under timeline
    rbox(ax, 3, 30, 94, 16,
         "Invariant preserved across all phases: bounded FIFO queue "
         "(Q_max=8), one-at-a-time\nexecution, allow/always/reject "
         "gating, logged four-tier failover, watchdog recovery",
         fc="#f1f5f9", ec="#334155", fs=6.8, rounding=2.4)
    ax.text(50, 16, "Safety invariants are never relaxed by future work "
            "- each phase slots into the existing tier and queue "
            "abstractions", ha="center", fontsize=6.6, color="#6b7280",
            style="italic")
    save(fig, "fig-future.png")


if __name__ == "__main__":
    fig_chain()
    fig_phases()
    fig_flow()
    fig_llm()
    fig_future()