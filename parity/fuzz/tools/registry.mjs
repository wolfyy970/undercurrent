// tools/registry.mjs — every fuzzed tool adapter, in one place.
//
// PORT-NOTE (1c: 12ca841): focus/glob/put/sub/view retired — upstream drops
// these five tools ("the mind reads and edits in bash"); their adapters
// (./focus.mjs, ./glob.mjs, ./put.mjs, ./sub.mjs, ./view.mjs) are removed.
import * as chat from "./chat.mjs";
import * as context from "./context.mjs";
import * as identity from "./identity.mjs";
import * as killall from "./killall.mjs";
import * as llm from "./llm.mjs";
import * as mem from "./mem.mjs";
import * as recap from "./recap.mjs";
import * as retrieval from "./retrieval.mjs";
import * as skills from "./skills.mjs";
import * as traj from "./traj.mjs";

export const TOOLS = { chat, context, identity, killall, llm, mem, recap, retrieval, skills, traj };
export const TOOL_NAMES = Object.keys(TOOLS);
