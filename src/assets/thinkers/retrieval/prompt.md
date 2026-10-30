# retrieval

Passive memory recall. For each new thought, message, or observation,
tokenize its content and look the words up in a word index over the
identity's memories (`build-index.sh`, rebuilt by `step` whenever a memory
is newer than the index). When a memory shares enough words with the step
and has not surfaced recently, emit an observation: "I'm reminded of memory
<id>: <summary>". Memories surface when the current step resonates with
them, without the mind asking. No LLM call unless `RETRIEVAL_SEMANTIC=1`.

Shipped disabled: enable it in the dashboard or delete the identity's
`disabled` marker. Updates preserve that per-identity choice.
