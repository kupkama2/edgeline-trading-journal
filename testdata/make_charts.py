"""Generate synthetic TradingView-like chart screenshots for QA of the AI parsing endpoint."""
import math
import random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

random.seed(7)

BG = "#131722"
GRID = "#1e222d"
UP = "#26a69a"
DOWN = "#ef5350"
TXT = "#d1d4dc"

ENTRY = 21450.0
STOP = 21400.0
TARGET = 21560.0


def candles(n, start, drift, vol):
    o = start
    out = []
    for _ in range(n):
        c = o + random.gauss(drift, vol)
        h = max(o, c) + abs(random.gauss(0, vol * 0.6))
        l = min(o, c) - abs(random.gauss(0, vol * 0.6))
        out.append((o, h, l, c))
        o = c
    return out


def draw(bars, path, title, levels, shade_from=None, extra_note=""):
    fig, ax = plt.subplots(figsize=(12.8, 7.2), dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    for i, (o, h, l, c) in enumerate(bars):
        col = UP if c >= o else DOWN
        ax.plot([i, i], [l, h], color=col, linewidth=1.0, zorder=3)
        ax.add_patch(
            Rectangle((i - 0.32, min(o, c)), 0.64, max(abs(c - o), 0.6),
                      facecolor=col, edgecolor=col, zorder=3)
        )

    n = len(bars)
    x0 = shade_from if shade_from is not None else 0

    # long position tool: green profit zone above entry, red risk zone below
    ax.add_patch(Rectangle((x0, ENTRY), n - x0, TARGET - ENTRY,
                           facecolor="#26a69a", alpha=0.11, zorder=1))
    ax.add_patch(Rectangle((x0, STOP), n - x0, ENTRY - STOP,
                           facecolor="#ef5350", alpha=0.13, zorder=1))

    for price, label, color in levels:
        ax.axhline(price, color=color, linewidth=1.4, linestyle="--", zorder=4)
        ax.text(n - 0.5, price, f" {label} {price:,.2f} ", color="#0b0e14",
                fontsize=11, va="center", ha="left", fontweight="bold",
                bbox=dict(facecolor=color, edgecolor="none", pad=2.5), zorder=5)

    ax.set_xlim(-1, n + 9)
    lo = min(b[2] for b in bars + [(STOP, STOP, STOP, STOP)]) - 15
    hi = max(b[1] for b in bars + [(TARGET, TARGET, TARGET, TARGET)]) + 15
    ax.set_ylim(lo, hi)
    ax.grid(color=GRID, linewidth=0.7)
    ax.set_axisbelow(True)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.tick_params(colors=TXT, labelsize=9)
    ax.set_xticks(range(0, n, 8))
    ax.set_xticklabels([f"09:{30 + i:02d}" if 30 + i < 60 else f"10:{30 + i - 60:02d}"
                        for i in range(0, n, 8)])
    ax.yaxis.tick_right()
    ax.text(0.008, 0.965, title, transform=ax.transAxes, color=TXT,
            fontsize=14, fontweight="bold", va="top")
    ax.text(0.008, 0.925, extra_note, transform=ax.transAxes, color="#8b93a7",
            fontsize=10, va="top")
    fig.tight_layout()
    fig.savefig(path, facecolor=BG)
    plt.close(fig)
    print("wrote", path)


# --- Setup screenshot: at entry, price hovering near entry ---
setup_bars = candles(46, 21395, 1.3, 9)
setup_bars[-1] = (setup_bars[-1][0], setup_bars[-1][1], setup_bars[-1][2], ENTRY)
draw(
    setup_bars,
    "/home/user/workspace/trading-journal-app/testdata/setup_chart.png",
    "NQ1!  ·  5m  ·  NASDAQ 100 E-mini",
    [(ENTRY, "Entry", "#2962ff"), (STOP, "Stop", "#ef5350"), (TARGET, "Target", "#26a69a")],
    shade_from=len(setup_bars) - 1,
    extra_note="Long  ·  Qty 2  ·  2026-08-05 09:52",
)

# --- Outcome screenshot: price runs to 21540 (MFE) then falls back, MAE 21418 ---
path_bars = list(setup_bars)
after = []
o = ENTRY
seq = [21432, 21418, 21446, 21478, 21505, 21538, 21541, 21512, 21489, 21470, 21462, 21455]
for c in seq:
    h = max(o, c) + 4
    l = min(o, c) - 4
    after.append((o, h, l, c))
    o = c
draw(
    path_bars + after,
    "/home/user/workspace/trading-journal-app/testdata/outcome_chart.png",
    "NQ1!  ·  5m  ·  post-trade price path",
    [(ENTRY, "Entry", "#2962ff"), (STOP, "Stop", "#ef5350"), (TARGET, "Target", "#26a69a")],
    shade_from=len(setup_bars) - 1,
    extra_note="Closed manually at 21489  ·  high 21541  ·  low 21418",
)
