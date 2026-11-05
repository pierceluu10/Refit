# Excerpt of MitchellHarrison/python-twitch-chatbot at 66beae079f7d, src/app.py, seen in P5.
SUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions"
    headers = {
        "Client-ID": env.client_id,
        "Authorization": f"Bearer {env.get_app_access()}",
        "Content-Type": content_type
    }
    data = {
        "type": type_,
        "version": "1",
        "condition": {"broadcaster_user_id": str(env.user_id)},
        "transport": {
            "method": "webhook",
            "callback": callback,
            "secret": secret
        }
    }
    response = requests.post(url, headers=headers, data=json.dumps(data))
    print("SUBSCRIPTION REQUEST RESULT")
    print(response.json())
    return response.json()

    request_user_auth()
    subs = get_subscriptions()
    print(subs)
    desired_subs = {
        "channel.follow": CALLBACK+"/event/new_follower",
        "channel.update": CALLBACK+"/event/stream_info_update",
        "stream.online": CALLBACK+"/event/stream_online",
        "stream.offline": CALLBACK+"/event/stream_offline",
        "channel.channel_points_custom_reward_redemption.add": CALLBACK+"/event/cp_redemption"
