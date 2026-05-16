#!/usr/bin/env bash
# pincer queue inspector. Usage:
#   ./scripts/queue.sh                 # current state of Daedelus404's queue
#   ./scripts/queue.sh -f              # follow mutation log live
#   ./scripts/queue.sh <bot-name>      # current state of a specific bot
set -e

PINCER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOT_NAME="${1:-Daedelus404}"

if [[ "$1" == "-f" ]]; then
    exec tail -f "${PINCER_ROOT}/queue.log"
fi

TASKS="${PINCER_ROOT}/bots/${BOT_NAME}/tasks.json"
if [[ ! -f "$TASKS" ]]; then
    echo "no tasks file for ${BOT_NAME} at ${TASKS}"
    exit 0
fi

echo "==> ${BOT_NAME} queue (from ${TASKS})"
python3 -c "
import json, sys
d = json.load(open('${TASKS}'))
tasks = d.get('tasks', [])
if not tasks:
    print('  (empty)')
else:
    for t in tasks:
        st = t['status']
        marker = {'in_progress': '▶', 'pending': '○', 'done': '✓'}.get(st, '?')
        print(f\"  {marker} #{t['id']:>3} [{st:>11}] {t['description']}\")
print()
print(f\"  next id: {d.get('nextId', '?')}\")
print(f\"  total: {len(tasks)} ({sum(1 for t in tasks if t['status']=='pending')} pending, {sum(1 for t in tasks if t['status']=='in_progress')} active, {sum(1 for t in tasks if t['status']=='done')} done)\")
"
