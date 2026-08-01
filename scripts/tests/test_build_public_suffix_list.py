from __future__ import annotations

from pathlib import Path

import pytest

from scripts.build_public_suffix_list import (
    SOURCE_URL,
    main,
    parse_rules,
    render_module,
)

# The shape of the real file: a header comment, the ICANN section with its
# ===BEGIN=== markers, a wildcard rule, an exception rule, and the PRIVATE
# section that carries the shared hosts.
SAMPLE = """\
// This Source Code Form is subject to the terms of the Mozilla Public License.

// ===BEGIN ICANN DOMAINS===

// com : https://example.invalid/
com

// uk : https://example.invalid/
uk
co.uk

// ck
*.ck
!www.ck

// ===END ICANN DOMAINS===

// ===BEGIN PRIVATE DOMAINS===

// GitHub
github.io

// ===END PRIVATE DOMAINS===
"""


def test_parses_rules_and_drops_comments_and_blanks():
    assert parse_rules(SAMPLE) == ["com", "uk", "co.uk", "*.ck", "!www.ck", "github.io"]


def test_keeps_both_sections():
    """PRIVATE carries the shared hosts, so dropping it would lose github.io."""
    rules = parse_rules(SAMPLE)
    assert "co.uk" in rules  # ICANN
    assert "github.io" in rules  # PRIVATE


def test_lowercases_rules():
    assert parse_rules("// c\nCO.UK\n") == ["co.uk"]


def test_rendered_module_carries_every_rule_and_says_how_to_regenerate():
    module = render_module(parse_rules(SAMPLE))

    assert module.startswith("// Generated file — do not edit.")
    assert SOURCE_URL in module
    assert "build_public_suffix_list.py" in module
    assert "export const PUBLIC_SUFFIX_RULES = `" in module
    for rule in parse_rules(SAMPLE):
        assert f"\n{rule}\n" in module


def test_rendered_module_refuses_a_rule_it_could_not_emit():
    """A rule carrying template-literal syntax would produce a module that does
    not parse, or one that parses as something else."""
    for bad in ("ba`d.test", "ba\\d.test", "ba${d}.test"):
        with pytest.raises(ValueError, match="cannot be emitted"):
            render_module([bad])


def test_rendered_module_refuses_an_empty_list():
    with pytest.raises(ValueError, match="empty"):
        render_module([])


def test_main_writes_the_module_from_a_local_file(tmp_path: Path):
    source = tmp_path / "psl.dat"
    source.write_text(SAMPLE, encoding="utf-8")
    output = tmp_path / "publicSuffixData.ts"

    assert main(["--input", str(source), "--output", str(output)]) == 0
    assert output.read_text(encoding="utf-8") == render_module(parse_rules(SAMPLE))


def test_check_mode_reports_staleness_without_writing(tmp_path: Path):
    source = tmp_path / "psl.dat"
    source.write_text(SAMPLE, encoding="utf-8")
    output = tmp_path / "publicSuffixData.ts"

    argv = ["--input", str(source), "--output", str(output), "--check"]
    assert main(argv) == 1
    assert not output.exists()

    main(argv[:-1])
    assert main(argv) == 0
