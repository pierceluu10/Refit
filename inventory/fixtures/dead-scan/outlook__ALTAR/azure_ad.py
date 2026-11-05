# Excerpt of outlook/ALTAR, azure_ad.py, seen in P5.
import requests


def get_groups(token):
    group_url = "https://graph.windows.net/me/memberOf?api-version=1.6"
    return requests.get(group_url, headers={"Authorization": token}).json()


def get_user_name(token):
    return requests.get(
        'https://graph.windows.net/me?api-version=1.6',
        headers={"Authorization": token},
    ).json()
