"""Static guards for CI contexts whose failures must not be hidden."""

from pathlib import Path


WORKFLOW = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml").read_text(
    encoding="utf-8"
)


def _section(name: str, next_name: str | None = None) -> str:
    start = WORKFLOW.index(f"  {name}:")
    end = WORKFLOW.index(f"  {next_name}:", start) if next_name else len(WORKFLOW)
    return WORKFLOW[start:end]


def test_main_ci_has_manual_dispatch_and_runs_version_parity_before_dependencies():
    assert "  workflow_dispatch:" in WORKFLOW
    tracker = _section("tracker", "dashboard")
    assert tracker.index("scripts/check_version_parity.py") < tracker.index(
        "Install dependencies"
    )


def test_protocol_parity_is_required_on_main_and_manual_runs():
    protocol = _section("protocol-parity", "quality-gate")
    assert "github.event_name == 'workflow_dispatch'" in protocol
    assert "github.ref == 'refs/heads/main'" in protocol
    assert "EXTENSION_REPOSITORY must be configured" in protocol
    assert 'TIME_PARITY_REQUIRED: "1"' in protocol
    # Fork PRs can skip the job when the private extension checkout cannot be
    # authorized, while a same-repository configured context still runs it.
    assert "github.event.pull_request.head.repo.full_name == github.repository" in protocol


def test_quality_gate_does_not_accept_skipped_parity_in_required_contexts():
    quality = _section("quality-gate")
    assert "PARITY_REQUIRED" in quality
    assert 'test "$PARITY_REQUIRED" = false' in quality
    assert "success|skipped" not in quality
