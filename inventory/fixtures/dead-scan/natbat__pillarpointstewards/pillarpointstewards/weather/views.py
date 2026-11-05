# Excerpt of natbat/pillarpointstewards, pillarpointstewards/weather/views.py, seen in P5.
import urllib.parse

import httpx


def fetch_weather(request, location, api_key):
    url = "https://api.openweathermap.org/data/2.5/onecall?" + urllib.parse.urlencode(
        {"lat": location.latitude, "lon": location.longitude, "appid": api_key}
    )
    response = httpx.get(url)
    assert response.status_code == 200
    return response.json()
