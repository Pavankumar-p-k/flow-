"""Generate the fallback-chain figure for the Agent Notch IEEE Word document."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import os

tiers = [
    ("Tier 1 — Hosted Session API",
     "OpenCode free models (mimo, deepseek, hy4) with in-chain rotation",
     "#dbeafe"),
    ("Tier 2 — OpenAI-Compatible Cloud",
     "OpenRouter / DeepSeek / Groq / any baseURL + key",
     "#e0f2fe"),
    ("Tier 3 — Local Runtime",
     "Ollama at 127.0.0.1:11434",
     "#dcfce7"),
    ("Tier 4 — Deterministic Offline",
     "Status, cached weather/news, queue state — never fails",
     "#fef9c3"),
]
fails = ["4xx / credit error", "5xx / timeout", "no daemon"]

fig, ax = plt.subplots(figsize=(6.6, 5.4), dpi=300)
ax.set_xlim(0, 100)
ax.set_ylim(0, 100)
ax.axis("off")

w, h = 78, 15
x = 11
ys = [80, 58, 36, 14]
for (title, sub, color), y in zip(tiers, ys):
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle="round,pad=1.2,rounding_size=3",
                         linewidth=1.4, edgecolor="#1f2937",
                         facecolor=color)
    ax.add_patch(box)
    ax.text(x + w / 2, y + h * 0.64, title, ha="center", va="center",
            fontsize=9.5, fontweight="bold", color="#111827")
    ax.text(x + w / 2, y + h * 0.28, sub, ha="center", va="center",
            fontsize=7.6, color="#374151")

for i, label in enumerate(fails):
    y0 = ys[i]
    y1 = ys[i + 1]
    ax.annotate("", xy=(x + w / 2, y1 + h + 0.8),
                xytext=(x + w / 2, y0 - 0.8),
                arrowprops=dict(arrowstyle="-|>", color="#6b7280",
                                lw=1.6, linestyle="dashed",
                                mutation_scale=13))
    ax.text(x + w / 2 + 2.5, (y0 + y1 + h) / 2, label, ha="left",
            va="center", fontsize=7.4, style="italic", color="#4b5563")

ax.text(50, 4, "Failure at any tier advances the router; reason is logged to the audit tail",
        ha="center", va="center", fontsize=7.4, color="#6b7280", style="italic")

out = os.path.join(os.path.dirname(__file__), "fig-chain.png")
fig.savefig(out, bbox_inches="tight", facecolor="white")
print("saved", out)