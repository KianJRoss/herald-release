"""Review several items one at a time with one model and one memory cache."""
from herald import Harness


# This list is the source of the information being reviewed. In a real
# program it could instead come from a database, API, spreadsheet, or form.
applications = [
    "Application 1: age 24, income $42,000, all documents included",
    "Application 2: age missing, income $38,000, all documents included",
    "Application 3: age 31, income $51,000, one document missing",
]


# create=True generates a small router.yaml if this folder does not have one.
app = Harness.open(".", create=True, name="application-review")

# Reopening this same name and memory reconnects to its encrypted history.
reviewer = app.agent(
    "ApplicationReviewer",
    memory="application-review-2026",
    model="auto",
    mode="efficiency",
    instructions="""
Apply the same eligibility standard to every application.
Missing required information or documents means needs-review.
Remember prior decisions so later decisions remain consistent.
""".strip(),
)


# Each iteration waits for the previous decision. No batching is required.
for application in applications:
    decision = reviewer.decide(
        question="What should happen to this application?",
        options=["approve", "reject", "needs-review"],
        context=application,
    )

    print(f"\n{application}")
    print(f"Decision: {decision.choice}")
    print(f"Reason: {decision.reason}")
    print(f"Confidence: {decision.confidence:.0%}")
