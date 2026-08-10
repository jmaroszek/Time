#!/usr/bin/env bash
# Check that every commit a push or pull request introduces is rustfmt-clean.
#
# The Windows job checks formatting once, against whichever commit happens to
# sit at the tip. When a push carries several commits that reports the failure
# against the wrong commit -- the tip is blamed for a problem a parent
# introduced -- which is what makes CI look arbitrary. Walking the commits
# individually keeps the blame exact, and is cheap enough to run every time
# because it needs no build.
#
# Four details here are load-bearing:
#
#   * rustfmt runs directly rather than through `cargo fmt`, so no manifest,
#     target directory or Tauri sidecar has to be present for a given commit.
#   * rustfmt is handed file paths. Given a source file on stdin it prints the
#     diff but still exits 0, so a stdin-based version of this check would
#     report success no matter what it found.
#   * rustfmt is handed crate entry points, not every source file. It follows
#     `mod` declarations, so passing both a root and the modules it reaches
#     checks each of them twice and prints every diff twice.
#   * a commit rustfmt cannot parse is reported as a warning, not a failure.
#     Intermediate commits in a series are not always self-contained, and
#     compilation is already gated on the tip by the Windows job. This job
#     stays about formatting alone so it cannot invent failures of its own.

set -euo pipefail

readonly MAX_COMMITS=50
# The whole crate directory rather than src/ alone, because build.rs lives
# beside it and cargo fmt covers that too. git archive only ever emits tracked
# files, so the ignored target/ directory cannot leak in.
readonly SOURCE_PATH='dashboard/src-tauri'
readonly MANIFEST_PATH='dashboard/src-tauri/Cargo.toml'
readonly DEFAULT_EDITION='2021'
readonly EMPTY_SHA='0000000000000000000000000000000000000000'

# On a pull request github.sha is the ephemeral merge commit rather than the
# branch tip, and blaming a commit nobody wrote helps no one, so prefer the
# pull request's own head. It stays reachable: the merge commit is its child.
case "${EVENT_NAME:-push}" in
  pull_request)
    base_sha="${PR_BASE:-}"
    head_sha="${PR_HEAD:-${HEAD_SHA:-$(git rev-parse HEAD)}}"
    ;;
  *)
    base_sha="${PUSH_BEFORE:-}"
    head_sha="${HEAD_SHA:-$(git rev-parse HEAD)}"
    ;;
esac

# A newly created branch reports an all-zero base, and a force push can report
# one that is no longer reachable. The range is meaningless in both cases, so
# fall back to checking the tip rather than failing the job outright.
commits=()
if [[ -n "$base_sha" && "$base_sha" != "$EMPTY_SHA" ]] &&
  git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  while IFS= read -r sha; do
    commits+=("$sha")
  done < <(git rev-list --reverse "${base_sha}..${head_sha}")
fi

if ((${#commits[@]} == 0)); then
  echo "No usable commit range; checking ${head_sha} on its own."
  commits=("$head_sha")
fi

if ((${#commits[@]} > MAX_COMMITS)); then
  echo "::warning::Push carries ${#commits[@]} commits;" \
    "checking only the newest ${MAX_COMMITS}."
  commits=("${commits[@]: -MAX_COMMITS}")
fi

failed=()
unparsed=()

for commit in "${commits[@]}"; do
  short="$(git rev-parse --short "$commit")"
  subject="$(git log -1 --format='%s' "$commit")"
  label="${short}  ${subject}"

  if ! git rev-parse --verify --quiet "${commit}:${SOURCE_PATH}" >/dev/null; then
    echo "skip  ${label}  (no ${SOURCE_PATH})"
    continue
  fi

  workdir="$(mktemp -d)"
  git archive "$commit" -- "$SOURCE_PATH" | tar -x -C "$workdir"
  crate="${workdir}/${SOURCE_PATH}"

  roots=()
  for candidate in build.rs src/lib.rs src/main.rs; do
    if [[ -f "${crate}/${candidate}" ]]; then
      roots+=("${crate}/${candidate}")
    fi
  done
  if [[ -d "${crate}/src/bin" ]]; then
    while IFS= read -r file; do
      roots+=("$file")
    done < <(find "${crate}/src/bin" -type f -name '*.rs' | sort)
  fi

  # An unfamiliar crate layout still needs checking, so fall back to every
  # source file rather than quietly checking nothing at all.
  if ((${#roots[@]} == 0)); then
    while IFS= read -r file; do
      roots+=("$file")
    done < <(find "$crate" -type f -name '*.rs' | sort)
  fi

  if ((${#roots[@]} == 0)); then
    echo "skip  ${label}  (no Rust sources)"
    rm -rf "$workdir"
    continue
  fi

  # Read the edition from the commit's own manifest so this keeps working
  # across an edition bump instead of silently checking against a stale one.
  edition="$(git show "${commit}:${MANIFEST_PATH}" 2>/dev/null |
    sed -n 's/^edition[[:space:]]*=[[:space:]]*"\([0-9]\{4\}\)".*/\1/p' |
    head -1)"
  edition="${edition:-$DEFAULT_EDITION}"

  if output="$(rustfmt --check --edition "$edition" "${roots[@]}" 2>&1)"; then
    echo "ok    ${label}"
  elif grep -q '^Diff in ' <<<"$output"; then
    if ((${#failed[@]} == 0)); then
      # Only the first offender gets its diff printed. Formatting carries
      # forward, so every later commit in the push would repeat it verbatim
      # and bury the one commit that actually needs editing.
      echo "FAIL  ${label}"
      sed "s|${workdir}/||g" <<<"$output"
    else
      echo "FAIL  ${label}  (inherits the formatting above)"
    fi
    failed+=("$label")
  else
    echo "warn  ${label}  (rustfmt could not parse this commit)"
    unparsed+=("$label")
  fi

  rm -rf "$workdir"
done

if ((${#unparsed[@]} > 0)); then
  for entry in "${unparsed[@]}"; do
    echo "::warning::Could not parse ${entry}; formatting not verified."
  done
fi

if ((${#failed[@]} == 0)); then
  echo "Formatting verified for ${#commits[@]} commit(s)."
  exit 0
fi

{
  echo '### Formatting'
  echo
  echo "First unformatted commit: \`${failed[0]}\`"
  echo
  if ((${#failed[@]} > 1)); then
    echo "Carried forward into $((${#failed[@]} - 1)) later commit(s)."
    echo
  fi
  echo 'Fix with `cargo fmt --manifest-path dashboard/src-tauri/Cargo.toml`.'
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

echo "::error::First unformatted commit: ${failed[0]}"

exit 1
