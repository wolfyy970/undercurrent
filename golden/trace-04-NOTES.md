# trace-04: the weather delivery-gap (a known behavior to fix, not a tool bug)

Captured from real pax (laude Bash, DeepSeek/OpenRouter), steps 205-266 of the root
trajectory. the operator asked for Springfield weather; the answer never arrived. Root cause is
architectural, and pax diagnosed it itself.

## What happened, by step
- 208 message[chat]: "Whats the weather today in Springfield?"
- 214 message[chat] / 215 observation[responder]: the RESPONDER replied "I'm on it —
  let me pull the current conditions." The responder is reply-only and HAS NO TOOLS.
- 218-219 monolith wake: the MONOLITH (which can act) ran `curl wttr.in` →
  `curl exit: 0  now: 81°F, feels 88°F, Partly Cloudy, humidity 85%`. Real data.
  But it landed in the monolith's private reasoning/shell-output steps.
- No `message[chat]` ever carried the result back. Only message steps reach the operator.
- 261 observation[monolith] / 264 final: pax reflected — "promises of real work from
  the responder only land if the monolith does the act… the monolith is the one with
  tools, so a work-request must become an act in the monolith, not just context." Saved
  as a memory. Called it an execution-discipline failure, not a handoff failure.

## The lesson (load-bearing for this port and any downstream consumer)
1. Tools WORK. Action = the model writing bash the sandbox runs. pax genuinely fetched
   live weather. Any faithful agent needs this exec path (the vertical slice).
2. The responder/monolith split can DROP work at the seam: the fast reply-only thinker
   promises, the tool-capable thinker acts but may not deliver, and the result dies in
   the stream. This is Headlong-as-shipped behavior.

## TODO (return to this)
- Reference port: reproduce this behavior faithfully first (parity), THEN decide the fix.
- The fix shape: when a message implies real work, either (a) the responder must hand a
  concrete "deliver X back to operator" obligation to the monolith, or (b) the monolith,
  after acting, must emit a message[chat] with the result — not just an observation.
  Headlong's own `share` function is the candidate delivery path; verify it against source.
- Downstream consumers: a detached-Mind design has the SAME seam (a wake acts in the Mind
  thread, never reaches the user) — trace-04 is the concrete reproduction to test any fix
  against.
