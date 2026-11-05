# Excerpt of MFaizanali2/Code-Review-Agent at 32fd5bb17d89, frontend/test_ui.py.
def test_review_sends_model(client, mock_post):
    client.review_code(github_url="https://github.com/test/repo", model="gemini-2.0-flash")
    payload = mock_post.call_args[1]["json"]
    assert payload["model"] == "gemini-2.0-flash"
