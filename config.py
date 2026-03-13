from pathlib import Path

DB_PATH = Path("C:/Users/jonah/Documents/Code/Time/Data/time_log.db")
LOG_PATH = Path("C:/Users/jonah/Documents/Code/Time/Logs/time_tracker.log")

# -- Time Tracker Settings ---------------------------------------------
IDLE_THRESHOLD_SECONDS = 180  # Seconds before marking idle
POLL_RATE_SECONDS = 15  # Seconds between each poll
DEFAULT_WEEKLY_PROD_GOAL = 20  # Default weekly productivity goal

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
    "excel.exe",
    "DB Browser for SQLite.exe",
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
    "top_apps": "C:/Users/jonah/Documents/Code/Time/Images/top_apps.png",
    "top_apps_stacked": "C:/Users/jonah/Documents/Code/Time/Images/top_apps_stacked.png",
    "prod_bars": "C:/Users/jonah/Documents/Code/Time/Images/prod_bars.png",
    "prod_pie": "C:/Users/jonah/Documents/Code/Time/Images/prod_pie.png",
    "stats": "C:/Users/jonah/Documents/Code/Time/Images/stats.png",
    "progress_bar": "C:/Users/jonah/Documents/Code/Time/Images/progress_bar.png",
}

# WARNING: app is currently not smart enough to dynamically resize the images if you change the window size. 
WIDTH = 2000  # GUI window width
HEIGHT = 1350  # GUI window height
DEFAULT_NUM_APPS = 5  # Default number of apps to show
DPI = 150  # Resolution for saved figures
