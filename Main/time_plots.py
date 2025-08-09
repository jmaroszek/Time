from datetime import datetime, timedelta

import matplotlib

matplotlib.use("Agg")
from collections import defaultdict

import matplotlib.pyplot as plt
import numpy as np
from config import DPI
from matplotlib.ticker import MultipleLocator
from time_analysis import clean_process_name

_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _pad_to_weeks(daily_productivity):
    """
    Take {'YYYY‑MM‑DD': {'Productive': s, 'Non‑Productive': s}} and return:

    • prod_matrix  (n_weeks × 7)  hours
    • nonprod_matrix (same)
    • n_weeks
    """
    # convert keys to date objects
    dates = [datetime.strptime(d, "%Y-%m-%d").date() for d in daily_productivity]
    if not dates:
        return np.zeros((0, 7)), np.zeros((0, 7)), 0

    first_sun = min(dates) - timedelta(days=(min(dates).weekday() + 1) % 7)
    last_date = max(dates)
    n_weeks = (last_date - first_sun).days // 7 + 1

    prod = np.zeros((n_weeks, 7))
    nonprod = np.zeros_like(prod)

    for d, rec in daily_productivity.items():
        dt = datetime.strptime(d, "%Y-%m-%d").date()
        w = (dt - first_sun).days // 7
        d_idx = (dt.weekday() + 1) % 7  # Sun = 0
        prod[w, d_idx] = rec["Productive"] / 3600
        nonprod[w, d_idx] = rec["Non-Productive"] / 3600

    return prod, nonprod, n_weeks


def secs_to_hrs_mins(seconds: float) -> tuple[int, int]:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    return hours, minutes


def plot_top_apps(
    total_use: list[tuple[str, float]], top_n: int = 5, *, save_to: str | None = None
):
    """
    Horizontal bar chart of the `top_n` processes.

    Parameters
    ----------
    total_use      : list[(proc, seconds)]
    top_n          : int
    save_to        : optional filepath – if provided, figure is saved there.

    Returns the matplotlib figure.
    """
    if not total_use:
        print("Total use variable is empty. Unable to plot.")
        return
    apps, secs = zip(*total_use[:top_n])
    hrs = np.array(secs) / 3600

    fig, ax = plt.subplots(figsize=(6, 3), dpi=DPI)
    bars = ax.barh(apps[::-1], hrs[::-1])

    ax.set_title(f"Top {top_n} Apps")
    ax.set_xlim(left=0)

    y_pos = np.arange(len(apps))
    ax.set_yticks(y_pos)
    ax.set_yticklabels([clean_process_name(a) for a in apps[::-1]])
    ax.spines[["right", "top"]].set_visible(False)

    # Add text labels at the end of each bar
    for i, bar in enumerate(bars):
        total_seconds = secs[::-1][i]
        h, m = secs_to_hrs_mins(total_seconds)
        label = f"{h}h {m}m" if h > 0 else f"{m}m"
        ax.text(
            bar.get_width() + 0.1,
            bar.get_y() + bar.get_height() / 2,
            label,
            va="center",
            ha="left",
            fontsize=9,
        )

    plt.tight_layout()
    if save_to:
        fig.savefig(save_to)
    plt.close(fig)


# time_plots.py


def plot_top_apps_stacked(
    daily_use: dict[str, list[tuple[str, str, float]]],
    top_n: int = 5,
    *,
    save_to: str | None = None,
):
    """
    Stacked bar chart of the top `n` apps across 1–5 weeks of daily data.

    Parameters
    ----------
    daily_use : dict[str, list[(proc, window_title, seconds)]]
        Mapping of 'YYYY-MM-DD' → list of (process_name, window_title, seconds).
    top_n     : int
        Number of top apps to track (1 ≤ n ≤ 5 recommended).
    save_to   : str | None, optional
        Filepath – if provided, the figure is written there (PNG).
    """
    if not daily_use:
        raise ValueError("No daily usage data provided.")

    # 1. Determine top-n apps over the full interval
    total_secs = defaultdict(float)
    for entries in daily_use.values():
        for proc, _, secs in entries:
            total_secs[proc] += secs

    top_apps = [
        proc for proc, _ in sorted(total_secs.items(), key=lambda x: -x[1])[:top_n]
    ]

    # 2. Build day-ordered data matrices
    dates = sorted(daily_use.keys())
    x_pos = np.arange(len(dates))

    hours_per_app = {app: np.zeros(len(dates)) for app in top_apps}
    other_hours = np.zeros(len(dates))

    for idx, day in enumerate(dates):
        # collapse all window-titles into a single proc→secs map
        day_dict = defaultdict(float)
        for proc, _, secs in daily_use[day]:
            day_dict[proc] += secs

        for app in top_apps:
            hours_per_app[app][idx] = day_dict.get(app, 0) / 3600

        # everything else
        other_secs = sum(
            secs for proc, _, secs in daily_use[day] if proc not in top_apps
        )
        other_hours[idx] = other_secs / 3600

    # 3. Plot stacked bars
    width = 0.8
    fig, ax = plt.subplots(figsize=(12.2, 4), dpi=DPI)

    bottom = np.zeros(len(dates))
    for app in top_apps:
        ax.bar(
            x_pos,
            hours_per_app[app],
            width,
            bottom=bottom,
            label=clean_process_name(app),
        )
        bottom += hours_per_app[app]

    if other_hours.any():
        ax.bar(
            x_pos,
            other_hours,
            width,
            bottom=bottom,
            label="Other",
            color="grey",
            alpha=0.4,
        )

    # 4. Cosmetics
    ax.set_title(f"Top {top_n} Apps Over Time")
    ax.set_ylabel("Hours")
    ax.set_xticks(x_pos)
    ax.set_xticklabels(
        [datetime.strptime(d, "%Y-%m-%d").strftime("%m/%d") for d in dates],
        rotation=45,
        ha="right",
        fontsize=10,
    )
    ax.grid(axis="y", linestyle="--", alpha=0.25)
    ax.spines[["right", "top"]].set_visible(False)
    ax.legend(bbox_to_anchor=(1.02, 1), loc="upper left")

    plt.tight_layout()
    if save_to:
        fig.savefig(save_to)
    plt.close(fig)


def plot_weekly_productivity_bars(
    daily_productivity: dict[str, dict[str, float]], *, save_to: str | None = None
):
    """
    Side‑by‑side bars (per week) + grey stacked caps (non‑productive).

    • Colours cycle automatically for up to 5 weeks.
    """
    prod, nonprod, n_weeks = _pad_to_weeks(daily_productivity)
    if n_weeks == 0:
        raise ValueError("No daily data!")

    x = np.arange(7)
    width = 0.8 / n_weeks

    fig, ax = plt.subplots(figsize=(6, 3), dpi=DPI)

    for w in range(n_weeks):
        offsets = x - 0.4 + width / 2 + w * width
        ax.bar(offsets, prod[w], width=width, label=f"W{w + 1}")
        ax.bar(
            offsets, nonprod[w], bottom=prod[w], width=width, color="grey", alpha=0.25
        )

    ax.set_xticks(x)
    ax.set_xticklabels(_DAYS)
    ax.yaxis.set_major_locator(MultipleLocator(2))
    ax.legend(title="Week", bbox_to_anchor=(1.02, 1), loc="upper left")
    ax.grid(axis="y", linestyle="--", alpha=0.15)
    ax.spines[["right", "top"]].set_visible(False)
    ax.set_title("Productivity")

    plt.tight_layout()
    if save_to:
        fig.savefig(save_to)
    plt.close(fig)


def plot_productive_pie(interval_stats: dict, *, save_to: str | None = None):
    """
    Tiny pie chart of productive vs non‑productive time for the whole interval.
    """
    prod = interval_stats["total_prod"] / 3600
    nonp = interval_stats["total_nonprod"] / 3600

    fig, ax = plt.subplots(figsize=(1, 1), dpi=DPI)
    wedges, texts = ax.pie([prod, nonp], colors=["#12b637", "#d81919"], startangle=90)
    ax.spines[["right", "top"]].set_visible(False)
    # ax.set_title("Prod vs Not", fontsize=8, color = 'white')
    plt.tight_layout()
    if save_to:
        fig.savefig(save_to, bbox_inches="tight", transparent=True)
    plt.close(fig)


def plot_interval_stats(interval_stats: dict, save_to: str | None = None):
    # ---- 1.  Pull numbers and convert to h / m ----
    total_h, total_m = secs_to_hrs_mins(interval_stats.get("total_time", 0))
    prod_h, prod_m = secs_to_hrs_mins(interval_stats.get("total_prod", 0))
    nonprod_h, nonprod_m = secs_to_hrs_mins(interval_stats.get("total_nonprod", 0))
    avg_prod_h, avg_prod_m = secs_to_hrs_mins(interval_stats.get("avg_prod_per_day", 0))
    avg_nonprod_h, avg_nonprod_m = secs_to_hrs_mins(
        interval_stats.get("avg_nonprod_per_day", 0)
    )

    # ---- 2.  Build table data ----
    col_labels = ["Total", "Avg"]
    row_labels = ["Productive", "Non‑Productive"]
    cell_text = [
        [f"{prod_h}h {prod_m}m", f"{avg_prod_h}h {avg_prod_m}m"],
        [f"{nonprod_h}h {nonprod_m}m", f"{avg_nonprod_h}h {avg_nonprod_m}m"],
    ]

    fig, ax = plt.subplots(figsize=(3, 1), dpi=150)

    ax.set_title(
        f"Total Time: {total_h}h {total_m}m",
        loc="center",
        pad=5,
        fontsize=10,
        fontweight="bold",
        color="white",
    )

    # 3b.  Build the table
    table = ax.table(
        cellText=cell_text,
        colLabels=col_labels,
        rowLabels=row_labels,
        cellLoc="center",
        loc="upper left",
    )

    # Cosmetic tweaks
    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1.0, 1.4)  # (w, h) scale factors
    ax.axis("off")

    # Optional: display the productivity ratio under the table
    # ax.text(.225, -0.2, f"Prod Ratio  {ratio:.2f}",
    #         transform=ax.transAxes, fontsize=10, color='white',fontweight="bold")

    # ---- 4.  Save (transparent PNG for easy GUI overlay) ----
    if save_to:
        fig.savefig(save_to, transparent=True, bbox_inches="tight")
    plt.close(fig)


def plot_progress_bar(
    interval_stats, *, weekly_prod_goal: float = 25.0, save_to: str | None = None
):
    """
    Bullet chart comparing productive time to a (daily_goal × n_days) target.

    Parameters
    ----------
    total_prod_secs : float
        Total productive time in **seconds** for the selected interval.
    n_days          : int
        Number of calendar days in the interval (inclusive).
    daily_goal_hours: float, optional
        Daily productivity goal in hours. Default = 4 h.
    save_to         : str | None, optional
        If provided, the figure is saved to this file (PNG). Otherwise the
        matplotlib Figure is returned.
    """
    # ---- 1.  Compute values (hours) ---------------------------------------
    prod_h = interval_stats["total_prod"] / 3600
    target_h = interval_stats["n_days"] * weekly_prod_goal / 7
    pct = prod_h / target_h if target_h else 0

    # ---- 2.  Build the bullet chart --------------------------------------
    fig, ax = plt.subplots(figsize=(3, 1), dpi=DPI)

    # * Goal bar (light grey)
    ax.barh(0, target_h, height=0.45, color="#d0d0d0")

    # * Actual bar  (blue; extends past goal if ›100 %)
    actual_len = min(prod_h, target_h)
    overflow = max(prod_h - target_h, 0)

    ax.barh(0, actual_len, height=0.45, color="#1f77b4")
    if overflow:  # highlight overshoot
        ax.barh(0, overflow, left=target_h, height=0.45, color="#12b637", alpha=0.8)

    # Thin vertical marker for the target (optional but nice)
    ax.axvline(target_h, color="black", linewidth=0.8)

    # ---- 3.  Cosmetics ----------------------------------------------------
    ax.set_title("Productivity Progress Bar", fontsize=9, pad=4, color="white")
    ax.set_yticks([])  # no y‑axis
    ax.set_xlim(0, max(prod_h, target_h) * 1.10 or 1)  # guard against zero
    ax.set_xlabel(
        f"{prod_h:.1f} h  /  {target_h:.1f} h  ({pct:0.0%})",
        fontsize=8,
        labelpad=6,
        color="white",
    )
    ax.spines[["right", "top", "left"]].set_visible(False)
    ax.xaxis.set_ticks_position("none")  # hide tick line
    ax.tick_params(axis="x", colors="white")

    plt.tight_layout()
    if save_to:
        fig.savefig(save_to, transparent=True)
        plt.close(fig)
