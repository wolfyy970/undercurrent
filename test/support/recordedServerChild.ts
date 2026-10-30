// recordedServerChild.ts — runs one recordedModel replay/record server in its own process, for code under test that
// calls `llm` synchronously (spawnSync) and would block an in-process server. Prints the URL on its first stdout
// line; exits when stdin closes (exit 3 if any request missed its recording, the misses on stderr).
import { recordedModel, type RecordedModelOptions } from "./recordedModel.ts";

const [suite, scenario, optsJson] = process.argv.slice(2);
if (!suite || !scenario) {
  process.stderr.write("usage: recordedServerChild.ts <suite> <scenario>\n");
  process.exit(2);
}
// Optional third argument: RecordedModelOptions as JSON (httpFixtures, cycle).
const m = recordedModel(suite, scenario, optsJson ? (JSON.parse(optsJson) as RecordedModelOptions) : {});
await m.ready;
process.stdout.write(m.url + "\n");
process.stdin.resume();
process.stdin.on("end", () => {
  m.close();
  if (m.misses.length) process.stderr.write(m.misses.join("\n") + "\n");
  process.exit(m.misses.length ? 3 : 0);
});
