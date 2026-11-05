# Excerpt of leedtan/chattutorial at c6122c20bb73, app.py, seen in P5.

    openai.api_key = OPENAI_API_KEY
api_bot = ApiBot("gpt-3.5-turbo", openai)
@app.route("/")
def home():
    if "conversation_history" in session:
        del session["conversation_history"]
    model_name = "gpt-3.5-turbo"
    port = 5000
    return render_template("index.html", model_name=model_name, port=port)
