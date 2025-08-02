# test.py
from time_analysis import get_daily_productivity

# 2) Dummy data for 2025-08-01
#    each tuple is: (process_name, window_title, duration_in_seconds)
sample_usage = {
    "2025-08-01": [
        # entertainment titles without our keywords → should be Productive
        ("chrome.exe", "Rick and Morty • xprime.tv", 60),
        ("chrome.exe", "Switch to Wi-Fi without unplugging • chatgpt.com", 30),
        (
            "chrome.exe",
            "Current Apex Legends map rotation | Apex Legends Status • apexlegendsstatus.com",
            45,
        ),
        ("chrome.exe", "Discord coding language • chatgpt.com", 40),
        # titles containing "movies" and/or "shows" → Non-Productive
        ("chrome.exe", "Search | Find your favorite movies and shows • xprime.tv", 120),
        ("chrome.exe", "Movies / TV / Anime • fmhy.net", 90),
    ]
}

if __name__ == "__main__":
    result = get_daily_productivity(sample_usage)
    print("Result:", result)
    day = "2025-08-01"
    assert result[day]["Productive"] == 70, (
        f"Productive mismatch: got {result[day]['Productive']} but expected 175"
    )
    assert result[day]["Non-Productive"] == 315, (
        f"Non-Productive mismatch: got {result[day]['Non-Productive']} but expected 210"
    )
    print("✔ test.py passed.")
