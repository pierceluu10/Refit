# Excerpt of BahadirKarsli/Chatbot-Assistant at 80037971dee2, custom_functions.py, seen in P5.
import json
import requests
import os
from openai import OpenAI
from assistant_instructions import assistant_instructions
# Init OpenAI Client
client = OpenAI(
    api_key=OPENAI_API_KEY,
    default_headers={"OpenAI-Beta": "assistants=v2"}
)
# Add lead to Airtable
def create_assistant(client):
  assistant_file_path = 'assistant.json'

  # If there is an assistant.json file already, then load that assistant
  if os.path.exists(assistant_file_path):
    with open(assistant_file_path, 'r') as file:
