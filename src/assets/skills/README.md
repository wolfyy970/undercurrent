# skills/

Skills that ship with the repo. A skill is a directory with a `SKILL.md`
that teaches the agent a procedure for a specialized task, e.g. using
chat, managing goals, or doing web research. The `skills` tool in
[bin/](../bin/) lists and loads them, and the
[skill-author](skill-author/SKILL.md) skill explains how to write a new
one.

An agent's own learned skills are data and live in its `.skills/`
directory, which is gitignored.
