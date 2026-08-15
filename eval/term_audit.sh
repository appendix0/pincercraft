#!/usr/bin/env bash
# Enforce docs/paper/terminology.md §7 ("words to avoid") over the paper prose.
#
# Two tiers, because not every document may be corrected:
#
#   ENFORCED  - live prose. A hit is a defect; the script exits non-zero.
#   EXEMPT    - historical records. Reported for awareness only, never failed.
#               preregistration.md (frozen §1-§12 + append-only deviations),
#               results.md (the exploratory campaign as it was reported) and
#               aborts.md (append-only incident log) legitimately contain terms
#               later deprecated. Backdating them would destroy the thing that
#               makes a pre-registration worth having.
#
# terminology.md itself is never scanned: it has to name the terms it bans.

cd "$(git rev-parse --show-toplevel)" || exit 1

ENFORCED="docs/paper/protocol.md docs/paper/related_work.md docs/paper/runbook.md README.md"
EXEMPT="docs/paper/preregistration.md docs/paper/results.md docs/paper/aborts.md"

fails=0

# rule <label> <extended-regex>
#
# Blockquote lines (`>`) are skipped. Rename notes and staleness banners have to
# name the term they are retiring — the same reason terminology.md itself is
# never scanned. Live prose is not written in blockquotes, so this costs no
# coverage.
rule() {
  local label=$1 pat=$2 hits
  hits=$(grep -rniE "$pat" $ENFORCED 2>/dev/null | grep -vE '^[^:]+:[0-9]+:\s*>')
  if [ -n "$hits" ]; then
    printf '\nFAIL  %s\n' "$label"
    printf '%s\n' "$hits" | sed 's/^/      /'
    fails=$((fails + 1))
  fi
}

echo "=== terminology.md §7 — enforced over: $ENFORCED ==="

rule "'safety layer' for gates -> precondition layer" \
     'safety layer|safety gate'
rule "'measurement layer' -> verify / autofinish, named individually" \
     'measurement layer'
rule "'the split' -> ablation" \
     'the split'
rule "bare 'seed' in prose -> shuffled backtest" \
     'seeds? [0-9]|per seed|three seeds|two seeds|each seed'
rule "'the harness improves success' as a headline" \
     'harness improves|improves success'
rule "'eliminated' for a zero count -> bound the rate" \
     '\beliminat(e|ed|es)\b.{0,40}(false completion|say-do|zero)'
rule "'capability' as an axis or grouping name -> task success" \
     'capability layer|capability axis|capability arms|three capability'
rule "'agent overstatement' as a metric -> say-do gap or false completion" \
     'overstatement (rate|metric)|agent overstatement'
rule "'the layers specialise' — H4 was not supported" \
     'layers specialis|layers specializ'
rule "'the reflex layer reduces false completion' — it does not" \
     'reflex layer reduces false'
rule "'scaffolding' for OUR system -> harness" \
     'our scaffold|the scaffold(ing)? (we|our)'
rule "A-ON / A-OFF -> full harness / no harness" \
     'A-ON|A-OFF'
rule "B1-B5 as layer-arm names -> named ablations (- perception, ...)" \
     '\bB[1-5]\b'
rule "'deterministic termination' -> completion recognition" \
     'deterministic termination'
rule "'the termination layers' -> the completion layers" \
     'termination layers'

echo
echo "=== exempt (historical records — reported, never failed) ==="
for f in $EXEMPT; do
  n=$(grep -rniE 'seeds? [0-9]|per seed|the split|measurement layer' "$f" 2>/dev/null | wc -l)
  printf '  %-34s %s deprecated-term line(s)\n' "$f" "$n"
done

echo
echo "=== canonical layer names in use ==="
for t in "perception layer" "precondition layer" "reflex layer" \
         "grounded completion check" "completion recognition" \
         "full harness" "no harness"; do
  n=$(grep -rniF "$t" docs/paper/*.md README.md 2>/dev/null | wc -l)
  printf '  %-28s %s\n' "$t" "$n"
done

echo
if [ "$fails" -eq 0 ]; then
  echo "PASS — no §7 violations in enforced prose."
else
  echo "$fails rule(s) violated in enforced prose."
fi
exit $((fails > 0))
