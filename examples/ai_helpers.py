"""Run with a Herald router available: python examples/ai_helpers.py"""
from pydantic import BaseModel

from herald import classify, extract, summarize


class Event(BaseModel):
    title: str
    date: str


if __name__ == "__main__":
    text = "Team demo is Friday, September 4. Show the new search experience."
    print(summarize(text, max_words=12, timeout=30))
    print(classify(text, ["meeting", "announcement", "question"], timeout=30))
    print(extract(text, Event, timeout=30))
