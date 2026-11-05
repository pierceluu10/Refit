# Excerpt of Brettjo77/YTAstroAssistant, weekly_ingest.py, seen in P5.
from youtube_transcript_api import YouTubeTranscriptApi


def fetch_transcript(video_id: str) -> str | None:
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        pieces = next(iter(transcript_list)).fetch()
        return " ".join(p["text"] for p in pieces)
    except Exception:
        return None
