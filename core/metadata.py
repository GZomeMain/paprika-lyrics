import re

def extract_clean_metadata(raw_title: str, raw_artist: str) -> tuple[str, str, str]:
    """
    Cleans noisy YouTube Music metadata, removing video labels, bracketed noise,
    and featuring artists to maximize resolution hit rates on Spotify and Apple Music.
    Returns: (cleaned_title, primary_artist, full_artist)
    """
    title = (raw_title or "").strip()
    artist = (raw_artist or "").strip()

    # Normalize full-width Asian brackets to standard brackets
    title = title.replace("【", "[").replace("】", "]").replace("（", "(").replace("）", ")")

    # Strip bracketed metadata noise
    bracket_noise = (
        r"[\(\[\{]\s*(?:official\s*(?:music\s*)?video|official\s*audio|visualizer|"
        r"lyrics?(\s*video)?|music\s*video|audio|mv|hd|4k|remaster(?:ed)?(?:\s*\d{4})?|"
        r"deluxe|bonus\s*track|explicit|clean)\s*[\)\]\}]"
    )
    title = re.sub(bracket_noise, "", title, flags=re.IGNORECASE)
    
    # Remove bracketed features e.g. "(feat. Drake)"
    title = re.sub(r"[\(\[\{]\s*(?:feat\.|ft\.).*?[\)\]\}]", "", title, flags=re.IGNORECASE)
    
    # Remove inline features e.g. "feat. Drake"
    title = re.sub(r"\b(?:feat\.|ft\.)\s+.*", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\b(?:official\s*video|official\s*audio|music\s*video|audio|lyrics)\b\s*$", "", title, flags=re.IGNORECASE)

    # Clean artist noise
    artist = re.sub(r"\s*-\s*topic$", "", artist, flags=re.IGNORECASE).strip()
    artist = re.sub(r"\b(?:feat\.|ft\.).*", "", artist, flags=re.IGNORECASE).strip()

    # If title starts with the artist name, strip it
    if artist:
        title = re.sub(rf"^{re.escape(artist)}\s*[-:|]\s*", "", title, flags=re.IGNORECASE)

    # Handle "Artist - Title" formatted titles
    if " - " in title:
        parts = title.split(" - ", 1)
        if artist and parts[0].strip().lower() == artist.lower():
            title = parts[1].strip()
        elif not artist:
            artist = parts[0].strip()
            title = parts[1].strip()

    title = re.sub(r"\s+", " ", title).strip(" -_[](){}:|")
    primary_artist = re.split(r"[,/&]", artist)[0].strip() if artist else ""

    return title, primary_artist, artist