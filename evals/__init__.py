"""PincerCraft deterministic evaluation layer.

Ground-truth task grading + adversarial cost metrics for the Daedelus404
self-improvement loop. Task success is decided ONLY by deterministic checks
(evals/checks.py) reading Mineflayer world-state snapshots — never by an LLM,
and never from the agent's own logs or self-reports.
"""
