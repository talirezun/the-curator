// Test fixture — always fails with NO transient marker (a genuine code defect).
// Used to verify the runner still FAILS the build on a reproducible defect.
console.log('  ✗ expected pages > 0 but got 0');
console.log('Failed: 1');
process.exit(1);
