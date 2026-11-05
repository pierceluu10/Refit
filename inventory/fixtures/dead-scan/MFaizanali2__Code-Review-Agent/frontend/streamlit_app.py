# Excerpt of MFaizanali2/Code-Review-Agent at 32fd5bb17d89, frontend/streamlit_app.py.
API_BASE_URL = "http://localhost:8000"
model = st.selectbox(
    "LLM Model",
    ["gemini-2.0-flash", "gemini-1.5-pro", "gpt-4o", "claude-3-5-sonnet"],
    label_visibility="collapsed"
)
