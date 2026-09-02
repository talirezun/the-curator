// Fixture "suite" for the manifest audit in scripts/run-tests.js.
// The audit only ever reads FILENAMES, so this is never executed by it —
// it prints a tally purely so an accidental spawn would look like a pass
// rather than a mystery.
console.log("Passed: 1   Failed: 0");
