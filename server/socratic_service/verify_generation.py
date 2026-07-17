from google import genai
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    print("API Key missing")
    exit(1)

client = genai.Client(api_key=GEMINI_API_KEY)

MODEL_NAME = os.getenv("GEMINI_DEFAULT_MODEL") or os.getenv("GEMINI_MODEL_NAME") or "gemini-2.0-flash"
print(f"Testing generation with model: {MODEL_NAME}")

try:
    response = client.models.generate_content(model=MODEL_NAME, contents="Hello, can you hear me?")
    print(f"Success! Response: {response.text}")
except Exception as e:
    print(f"Failed with {MODEL_NAME}: {e}")
