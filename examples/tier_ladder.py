"""Executable tour of Herald's integration ladder (requires a router)."""
import herald


if __name__ == "__main__":
    note = "The build is failing after the dependency update."
    print(herald.classify(note, ["bug", "feature"], timeout=30))
    print(herald.summarize(note))
    print(herald.quick("Name one likely cause of a dependency build failure."))
    print(herald.chat("Suggest a debugging plan", context=note))

    part = herald.project("examples").part("build-triage")
    print(part.classify(note, ["bug", "feature"], timeout=30))
    print(part.agentic("Investigate this build report and propose next steps: " + note))
    # During agentic execution the model may use the consult_models agent tool
    # for bounded parallel or sequential advice from additional models.
