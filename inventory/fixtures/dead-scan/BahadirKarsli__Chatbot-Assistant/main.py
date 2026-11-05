# Excerpt of BahadirKarsli/Chatbot-Assistant at 80037971dee2, main.py, seen in P5.
# Initialize OpenAI client
client = OpenAI(
    api_key=OPENAI_API_KEY,
    default_headers={"OpenAI-Beta": "assistants=v2"}
)

# Create or load assistant
assistant_id = custom_functions.create_assistant(
    client)  # this function comes from "functions.py"


