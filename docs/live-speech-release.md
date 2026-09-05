# Live speech draft

WHY: The previous dialog disabled interim results and auto-sent the first final phrase, preventing users from watching and correcting dictation.

GOAL: Show real recognition hypotheses while the user speaks in a task conversation.

ACCEPTANCE CRITERIA: Interim text appears immediately when supplied by the browser; revised results replace hypotheses without duplication; stopping preserves an editable draft; only explicit Send submits it; aborted sessions cannot overwrite manual edits or another task.

IMPLEMENTATION: Extend the existing browser SpeechRecognition integration with interimResults and continuous recognition. Preserve typed prefixes, cap drafts at the input limit, and disable Send while listening. Keep the existing Google Tasks backend unchanged. Bump offline cache and loader release. This uses browser recognition corrections, not an LLM contextual rewrite.

TEST: npm run verify: 317 tests, 315 passed, 2 existing optional browser tests skipped. git diff --check passed. A local isolated browser fixture using the production component and a simulated recognition engine showed interim 四店, revised 四点, preserved draft on Stop, zero submissions until Send, then exactly one submission. Unit tests cover stale events, errors, startup failures, final correction after Stop, multiple result snapshots, typed prefix, and length limit.

RESULT: Frontend ready for publication. Real iPhone microphone latency and browser interim-result availability still require device acceptance; synthetic events are not acoustic recognition validation. No new service, credentials, or dependency introduced.
