// Test fixture — fails the FIRST time (no transient marker), passes on RETRY.
// Verifies the runner retries ANY failed live suite and recovers on a pass.
import fs from 'fs';
const marker = process.env.RECOVER_MARKER;
if (marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  console.log('  ✗ flaky miss (first attempt)');
  console.log('Failed: 1');
  process.exit(1);
}
console.log('Passed: 1   Failed: 0');
process.exit(0);
