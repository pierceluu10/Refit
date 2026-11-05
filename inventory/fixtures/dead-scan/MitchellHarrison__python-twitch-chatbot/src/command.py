# Excerpt of MitchellHarrison/python-twitch-chatbot at 66beae079f7d, src/command.py, seen in P5.
            year = words[1]

            # get fact from api
            url = f"http://numbersapi.com/{year}/year"
            fact = requests.get(url).text

            # send fact in chat
