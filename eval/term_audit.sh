#!/usr/bin/env bash
# Check live paper prose against docs/paper/terminology.md §7 ("words to avoid").
# Run it by eye before writing manuscript text.
#
# Scans live docs only. The frozen records (preregistration, aborts) keep the
# labels they were written with; terminology.md §1.1 maps them.
# terminology.md itself is skipped -- it has to name the terms it bans.

cd "$(git rev-parse --show-toplevel)" || exit 1
FILES="docs/paper/protocol.md docs/paper/related_work.md docs/paper/runbook.md docs/paper/results.md README.md"

# banned pattern <TAB> what to use instead
RULES='backtests?	replicate
safety layer	precondition layer
measurement layer	verify / autofinish, named separately
the split	ablation
completion recognition	deterministic termination
A-ON|A-OFF	full harness / no harness
capability (layer|axis|arms)	task success
harness improves	"a stock agent overstates itself by N points"
layers specialis	no single layer cleared the MEI (H4 not supported)'

fails=0
while IFS=$'\t' read -r pat use; do
  hits=$(grep -rniE "$pat" $FILES 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*>')
  [ -z "$hits" ] && continue
  printf '\n%s  ->  %s\n' "$pat" "$use"
  printf '%s\n' "$hits" | sed 's/^/    /'
  fails=$((fails + 1))
done <<< "$RULES"

echo
[ "$fails" -eq 0 ] && echo "PASS — no §7 violations in live prose." \
                   || echo "$fails rule(s) hit."
exit $((fails > 0))
