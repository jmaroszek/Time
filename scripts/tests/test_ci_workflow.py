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
    assert (
        "    if: >-\n"
        "      github.event_name == 'workflow_dispatch' ||\n"
        "      (github.event_name == 'push' && github.ref == 'refs/heads/main')\n"
    ) in protocol
    assert "EXTENSION_REPOSITORY must be configured" in protocol
    assert 'TIME_PARITY_REQUIRED: "1"' in protocol
    assert "pull_request" not in protocol


def test_protocol_parity_does_not_persist_the_private_checkout_credential():
    protocol = _section("protocol-parity", "quality-gate")
    private_checkout = protocol[
        protocol.index("      - name: Check out the extension repository") : protocol.index(
            "      - uses: actions/setup-python@v6"
        )
    ]
    assert "token: ${{ secrets.EXTENSION_REPO_TOKEN || github.token }}" in private_checkout
    assert "persist-credentials: false" in private_checkout


def test_quality_gate_does_not_accept_skipped_parity_in_required_contexts():
    quality = _section("quality-gate")
    assert "PARITY_REQUIRED" in quality
    assert 'test "$PARITY_REQUIRED" = false' in quality
    assert "success|skipped" not in quality
