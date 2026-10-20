import base64, os, sys
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
client = OpenAI(api_key=os.environ["NEBIUS_API_KEY"], base_url=os.environ["NEBIUS_BASE_URL"])

# 1. Planner: text only
r = client.chat.completions.create(
    model=os.environ["NEMOTRON_PLANNER_MODEL"],
    messages=[{"role": "user", "content": "Reply with exactly: planner ready"}],
        max_tokens=1024,
)
m = r.choices[0].message
print("planner:", m.content, "| finish:", r.choices[0].finish_reason,
      "| reasoning:", (getattr(m, "reasoning_content", None) or "")[:150])
# 2. Verifier: one image
img = sys.argv[1] if len(sys.argv) > 1 else "bus.jpg"
b64 = base64.b64encode(open(img, "rb").read()).decode()
r = client.chat.completions.create(
    model=os.environ["NEMOTRON_VERIFIER_MODEL"],
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "Is there a person in this image? Answer yes or no, then one short sentence."},
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
    ]}],
        max_tokens=1024,
)
m = r.choices[0].message
print("planner:", m.content, "| finish:", r.choices[0].finish_reason,
      "| reasoning:", (getattr(m, "reasoning_content", None) or "")[:150])