from pathlib import Path

"""
Project configuration file for the Time Analysis suite.
All shared constants and file paths live here.
"""

# -- Database Settings -------------------------------------------------
DB_PATH = Path(r"C:/Users/Jonah/Documents/Code/Time/Data/time_log.db")

# -- Logging Settings --------------------------------------------------
LOG_PATH = Path(r"C:/Users/Jonah/Documents/Code/Time/Logs/time_tracker.log")

# -- Time Tracker Settings ---------------------------------------------
IDLE_THRESHOLD_SECONDS = 180  # Seconds before marking idle
POLL_RATE_SECONDS = 5  # Seconds between each poll
MOUSE_MOVE_THRESHOLD = 10  # minimum move threshold for activity in pixels

# -- Analysis Settings -------------------------------------------------
TOP_COUNT = 10  # Top processes to display
WEEK_START = "Sunday"  # Week start day for boundary functions
PRODUCTIVE_APPS = [  # Processes considered 'productive'; case insensitive
    "obsidian.exe",
    "code.exe",
    "chrome.exe",
    "python.exe",
    "Notepad.exe",
    "explorer.exe",
    "Thorium.exe",
    "SumatraPDF.exe",
]
UNPRODUCTIVE_CHROME_KEYWORDS = {
    "youtube",
    "reddit",
    "porn",
    "amazon",
    "tv",
    "stream",
    "movies",
    "movie",
    "shows",
    "show",
    "watch",
    "steam",
    "apex",
    "stream",
}

# -- GUI Settings ------------------------------------------------------
# Paths for generated plot images
IMAGE_PATHS = {
    "top_apps": r"C:/Users/Jonah/Documents/Code/Time/Images/top_apps.png",
    "top_apps_stacked": r"C:/Users/Jonah/Documents/Code/Time/Images/top_apps_stacked.png",
    "prod_bars": r"C:/Users/Jonah/Documents/Code/Time/Images/prod_bars.png",
    "prod_pie": r"C:/Users/Jonah/Documents/Code/Time/Images/prod_pie.png",
    "stats": r"C:/Users/Jonah/Documents/Code/Time/Images/stats.png",
    "progress_bar": r"C:/Users/Jonah/Documents/Code/Time/Images/progress_bar.png",
}
WIDTH = 2000  # GUI window width
HEIGHT = 1350  # GUI window height
DEFAULT_NUM_APPS = 5  # Default number of apps to show
DEFAULT_WEEKLY_PROD_GOAL = 30  # Default weekly productivity goal

# -- Plot Settings -----------------------------------------------------
DPI = 150  # Resolution for saved figures
