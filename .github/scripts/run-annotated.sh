#!/usr/bin/env bash
# Run a CI check and, if it fails, publish the tail of its output as a GitHub
# annotation. Annotations are readable through the checks API even where raw
# job logs are not, so failures stay diagnosable from any environment.
#
# Usage: .github/scripts/run-annotated.sh <title> <command> [args...]
set -uo pipefail

title="$1"
shift

output_file="$(mktemp)"
"$@" 2>&1 | tee "$output_file"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  # Annotation messages: escape %, CR and LF per the workflow-command format.
  tail -n 80 "$output_file" |
    sed -e 's/%/%25/g' -e 's/\r/%0D/g' |
    awk -v title="$title" -v status="$status" '
      { lines = lines (NR > 1 ? "%0A" : "") $0 }
      END { printf "::error title=%s (exit %s)::%s\n", title, status, lines }
    '
fi

# Optionally publish a success summary (e.g. test counts) as a notice, so the
# result is visible through the checks API without reading raw logs.
if [ "$status" -eq 0 ] && [ "${ANNOTATE_SUCCESS_TAIL:-0}" -gt 0 ]; then
  tail -n "$ANNOTATE_SUCCESS_TAIL" "$output_file" |
    sed -e 's/%/%25/g' -e 's/\r/%0D/g' |
    awk -v title="$title" '
      { lines = lines (NR > 1 ? "%0A" : "") $0 }
      END { printf "::notice title=%s (passed)::%s\n", title, lines }
    '
fi

rm -f "$output_file"
exit "$status"
