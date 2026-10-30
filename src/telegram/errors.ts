// errors.ts — shared "die with a message" signal for the telegram bridge.
//
// Faithful port of the Python bridge's `raise SystemExit("message")` idiom
// (config.py, mindlog.py): an uncaught `SystemExit(str)` in Python prints the
// string to stderr and exits 1. `BridgeExit` is the TS analogue — thrown from
// anywhere in the bridge, caught once at the CLI boundary (cli.ts), printed
// to stderr verbatim, exit code 1.

export class BridgeExit extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeExit";
  }
}
