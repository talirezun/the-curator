// Test fixture — always fails with a TRANSIENT provider marker (Gemini 503).
// Used to verify the runner classifies a sustained provider outage as
// INCONCLUSIVE (not a hard failure) after its one retry.
console.log('⚠ Gemini infrastructure is temporarily overloaded (HTTP 503).');
console.log('Failed: 1');
process.exit(1);
