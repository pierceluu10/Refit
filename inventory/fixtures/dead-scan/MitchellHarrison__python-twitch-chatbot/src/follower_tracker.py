# Excerpt of MitchellHarrison/python-twitch-chatbot at 66beae079f7d, src/follower_tracker.py, seen in P5.
FOLLOW_URL = "https://api.twitch.tv/helix/users/follows"
FOLLOW_HEADERS = {
    "Authorization": f"Bearer {env.app_access}",
    "Client-Id": env.client_id
}
def get_follower_count(env=env) -> int:
    # api response
    response = requests.get(
        url=FOLLOW_URL, 
        headers=FOLLOW_HEADERS, 
        params={"to_id":env.user_id}
    ).json()
    follow_count = response["total"]
    return follow_count
