import os
import random
import sqlite3
from datetime import datetime, timedelta

import config
import dearpygui.dearpygui as dpg
from time_analysis import (
    get_daily_productivity,
    get_daily_use,
    get_interval_stats,
    get_last_n_weeks_bounds,
    get_last_weeks_bounds,
    get_this_weeks_bounds,
    get_timestamp_bounds,
    get_total_use,
)
from time_plots import (
    plot_interval_stats,
    plot_productive_pie,
    plot_progress_bar,
    plot_top_apps,
    plot_top_apps_stacked,
    plot_weekly_productivity_bars,
)

# 4) Create a desktop shortcut. This will probably be a shortcut that launches a bash script that runs time_gui.py.


# Will hold the texture tags after setup
texture_tags: dict[str, str] = {}


# ----------------- Helper Functions -------------------
def unix_to_date(unix_time: float) -> str:
    return datetime.fromtimestamp(unix_time).strftime("%m/%d/%y")


def secs_to_hrs_mins(seconds: float) -> tuple[int, int]:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    return hours, minutes


# --------------- Texture Management -------------------
def setup_textures(paths: dict[str, str]) -> dict[str, str]:
    """Load each image once and register it as a dynamic texture."""
    tags: dict[str, str] = {}
    with dpg.texture_registry(show=False):
        for name, path in paths.items():
            w, h, _, data = dpg.load_image(path)
            tag = f"{name}_tex"
            dpg.add_dynamic_texture(w, h, data, tag=tag)
            tags[name] = tag
    return tags


def update_textures(paths: dict[str, str], tags: dict[str, str]):
    """Reload each file from disk and push its bytes into its dynamic texture."""
    for name, path in paths.items():
        _, _, _, new_data = dpg.load_image(path)
        dpg.set_value(tags[name], new_data)


# ----------------- UI Event Handlers ------------------
def handle_date_dropdown(_, date_range: str):
    match date_range:
        case "Today":
            today = datetime.now().date()
            start_dt = datetime.combine(today, datetime.min.time())
            end_dt = start_dt  # inclusive date shown in the UI
        case "This Week":
            start_ts, end_ts = get_this_weeks_bounds()
            start_dt = datetime.fromtimestamp(start_ts)
            end_dt = datetime.fromtimestamp(end_ts) - timedelta(days=1)
        case "Last Week":
            start_ts, end_ts = get_last_weeks_bounds()
            start_dt = datetime.fromtimestamp(start_ts)
            end_dt = datetime.fromtimestamp(end_ts) - timedelta(days=1)
        case "Last Month":
            start_ts, end_ts = get_last_n_weeks_bounds(4)
            start_dt = datetime.fromtimestamp(start_ts)
            end_dt = datetime.fromtimestamp(end_ts) - timedelta(days=1)
        case "PIMLI":
            start_ts, end_ts = get_last_n_weeks_bounds(6)
            start_dt = datetime.fromtimestamp(start_ts)
            end_dt = datetime.fromtimestamp(end_ts) - timedelta(days=1)
        case _:
            return

    dpg.set_value(start_date_text_field, start_dt.strftime("%m/%d/%y"))
    dpg.set_value(end_date_text_field, end_dt.strftime("%m/%d/%y"))
    update()


# ----------------- Main Update Loop -------------------
def update():
    # 1) get data from UI
    start_str = dpg.get_value(start_date_text_field)
    end_str = dpg.get_value(end_date_text_field)
    num_apps = dpg.get_value(app_number)
    week_prod_goal = dpg.get_value(weekly_prod_goal_input)

    try:
        start_ts, end_ts = get_timestamp_bounds(start_str, end_str)
    except ValueError:
        print("Invalid date format")
        return

    # 2) query database
    with sqlite3.connect(config.DB_PATH) as conn:
        daily_use = get_daily_use(conn, start_ts, end_ts)
        total_use = get_total_use(conn, start_ts, end_ts)

    # 3) compute stats
    daily_prod = get_daily_productivity(daily_use)
    interval_stats = get_interval_stats(total_use, daily_prod)

    # 4) regenerate plots
    plot_top_apps(total_use, num_apps, save_to=config.IMAGE_PATHS["top_apps"])
    plot_top_apps_stacked(
        daily_use, top_n=num_apps, save_to=config.IMAGE_PATHS["top_apps_stacked"]
    )
    plot_weekly_productivity_bars(daily_prod, save_to=config.IMAGE_PATHS["prod_bars"])
    plot_productive_pie(interval_stats, save_to=config.IMAGE_PATHS["prod_pie"])
    plot_interval_stats(interval_stats, save_to=config.IMAGE_PATHS["stats"])
    plot_progress_bar(
        interval_stats,
        weekly_prod_goal=week_prod_goal,
        save_to=config.IMAGE_PATHS["progress_bar"],
    )

    # 6) refresh all dynamic textures
    update_textures(config.IMAGE_PATHS, texture_tags)


# ----------------- Initialization ---------------------
def init():
    # Note that the fake images are never seen. They are just needed to initalize the textures
    # They are overwritten immediately by the default query.
    if not all(os.path.exists(path) for path in config.IMAGE_PATHS.values()):
        print("No base images. Generating fake data")
        processes = [
            "obsidian.exe",
            "code.exe",
            "chrome.exe",
            "discord.exe",
            "steam.exe",
            "apex.exe",
        ]

        productive_set = {"obsidian.exe", "code.exe", "chrome.exe"}

        # Base‑second values for weekday vs weekend
        BASES = {
            "weekday": {"prod": 3600, "non": 900},
            "weekend": {"prod": 300, "non": 3600},
        }

        today = datetime.today().date()
        days_since_sun = (
            today.weekday() + 1
        ) % 7  # Sun==0 → 0, Mon==1 → 1, … Sat==6 → 6
        start_date = today - timedelta(days=days_since_sun)

        daily_use = {}
        total_use_counter = {}

        for i in range(35):
            current_date = start_date + timedelta(days=i)
            date_str = current_date.strftime("%Y-%m-%d")
            entries = []

            weekend = current_date.weekday() >= 5
            base_key = "weekend" if weekend else "weekday"

            for proc in processes:
                is_prod = proc in productive_set
                base = BASES[base_key]["prod" if is_prod else "non"]
                noise = random.randint(-300, 300)
                seconds = max(0, base + noise)

                entries.append((proc, seconds))
                total_use_counter[proc] = total_use_counter.get(proc, 0) + seconds

            daily_use[date_str] = entries

        daily_productivity = {}
        productive_set = set(p.lower() for p in productive_set)
        for day, proc_list in daily_use.items():
            prod = 0
            nonprod = 0
            for proc, secs in proc_list:
                if proc.lower() in productive_set:
                    prod += secs
                else:
                    nonprod += secs
            daily_productivity[day] = {"Productive": prod, "Non-Productive": nonprod}

        total_use = sorted(total_use_counter.items(), key=lambda x: -x[1])
        interval_stats = get_interval_stats(total_use, daily_productivity)

        plot_top_apps(total_use, save_to=config.IMAGE_PATHS["top_apps"])
        plot_weekly_productivity_bars(
            daily_productivity, save_to=config.IMAGE_PATHS["prod_bars"]
        )
        plot_productive_pie(interval_stats, save_to=config.IMAGE_PATHS["prod_pie"])
        plot_interval_stats(interval_stats, save_to=config.IMAGE_PATHS["stats"])
        plot_top_apps_stacked(daily_use, save_to=config.IMAGE_PATHS["top_apps_stacked"])
        plot_progress_bar(interval_stats, save_to=config.IMAGE_PATHS["progress_bar"])


# ---------------------- Entry Point -------------------
if __name__ == "__main__":
    # Setup
    dpg.create_context()
    init()
    texture_tags = setup_textures(config.IMAGE_PATHS)
    # for positioning the images
    x_left = 10
    y_top = 200
    x_right = 940
    y_bottom = 680

    # Build GUI
    with dpg.window(
        label="Time Analysis",
        width=config.WIDTH,
        height=config.HEIGHT,
        no_move=True,
        no_close=True,
    ):
        dpg.add_spacer(height=8)
        dpg.add_text("Date Selector")
        with dpg.group(horizontal=True):
            date_dropdown = dpg.add_combo(
                ("Today", "This Week", "Last Week", "Last Month", "PIMLI"),
                default_value="This Week",
                callback=handle_date_dropdown,
                width=110,
            )
            dpg.add_text("OR")
            start_date_text_field = dpg.add_input_text(
                label="to",
                callback=update,
                on_enter=True,
                default_value=unix_to_date(get_this_weeks_bounds()[0]),
                width=100,
            )
            end_date_text_field = dpg.add_input_text(
                callback=update,
                on_enter=True,
                default_value=unix_to_date(get_this_weeks_bounds()[1] - 24 * 3600),
                width=100,
            )

        dpg.add_spacer(height=5)
        dpg.add_text("Number of Apps")
        app_number = dpg.add_input_int(default_value=5, callback=update, width=100)
        dpg.add_text("Weekly Prod. Goal")
        weekly_prod_goal_input = dpg.add_input_int(
            default_value=config.DEFAULT_WEEKLY_PROD_GOAL,
            callback=update,
            width=100,
        )
        dpg.add_spacer(height=15)

        # Insert each dynamic image by its tag
        dpg.add_image(texture_tags["stats"], pos=(200, 25))
        dpg.add_image(texture_tags["prod_pie"], pos=(770, 50))
        dpg.add_image(texture_tags["progress_bar"], pos=(1150, 50))
        dpg.add_image(texture_tags["top_apps"], pos=(x_right, y_top))
        dpg.add_image(texture_tags["prod_bars"], pos=(x_left, y_top))
        dpg.add_image(texture_tags["top_apps_stacked"], pos=(x_left, y_bottom))

        update()

    # Show & run
    dpg.create_viewport(
        title="Time Analysis",
        width=config.WIDTH,
        height=config.HEIGHT,
        x_pos=1100,
        y_pos=0,
    )
    dpg.setup_dearpygui()
    dpg.show_viewport()
    dpg.start_dearpygui()
    dpg.destroy_context()
