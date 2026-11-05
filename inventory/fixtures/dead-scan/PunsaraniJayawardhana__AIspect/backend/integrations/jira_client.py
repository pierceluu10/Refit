# Excerpt of PunsaraniJayawardhana/AIspect, backend/integrations/jira_client.py, seen in P5.
import requests

from backend.config import JIRA_BASE_URL, JIRA_API_TOKEN


def get_story(story_key):
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{story_key}"
    return requests.get(url, headers={"Authorization": f"Basic {JIRA_API_TOKEN}"}).json()
