import assert from 'node:assert';
// Mirror of FisbNexrad._productOf (kept in sync; pure function).
const productOf = (b) => (b.radarType === 64 || b.scale > 0) ? 'conus' : 'regional';

assert.equal(productOf({ radarType: 63, scale: 0 }), 'regional');
assert.equal(productOf({ radarType: 64, scale: 1 }), 'conus');
assert.equal(productOf({ radarType: 63, scale: 1 }), 'conus'); // scale wins
assert.equal(productOf({ radarType: 64, scale: 0 }), 'conus'); // type wins
console.log('OK productOf');
