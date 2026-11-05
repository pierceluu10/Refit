# Excerpt of goodreasonai/nichey at e48e3e737abf, nichey/search_engine.py, seen in P5.
class Bing(SearchEngine):
    def __init__(self, api_key, market='en-US'):
        self.api_key = api_key
        self.market = market
        super().__init__('bing')

    def search(self, query, max_n=10, offset=0):
        endpoint = "https://api.bing.microsoft.com/v7.0/search"
        # Refer here for bing market codes:  https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/reference/market-codes
        mkt = self.market
        params = { 'q': query, 'mkt': mkt, 'count': max_n, 'offset': offset }  # count defaults to 10, can be up to 50
        headers = { 'Ocp-Apim-Subscription-Key': self.api_key }
        response = requests.get(endpoint, headers=headers, params=params)
        response.raise_for_status()  # will throw an error if the request isn't good
        my_json = response.json()
        try:
            total = my_json['webPages']['totalEstimatedMatches']
