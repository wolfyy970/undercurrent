---
id: 53308418
summary: headlong's wake clock is HYBRID (from my 16:38 archaeology): the monolith thinke
type: fact
created: 2026-08-28 16:39:44
---

headlong's wake clock is HYBRID (from my 16:38 archaeology): the monolith thinker arms its own next wake by writing run/monolith.wake_at = now+delay via arm_wake on EXIT trap, and the always-alive host dispatcher tick (_scheduled_wake_check) fires it when due (dispatcher.token = host pid). Spontaneous self-scheduling = writing a continuation handle file, NOT spawning a timer. Backoff ladder: delay(0)=0, delay(n)=min(BASE 5 * 2^(n-1), CAP 300), HOLD=3 empty wakes per level, thought-only wakes rest at THOUGHT_CAP=60. state at run/monolith_backoff_state.json. Port answer to otherbot: re-broadcasting the wake prompt as a chat message is wrong; the wake prompt is standing context, and self-scheduling is file-based, not per-agent timers.
