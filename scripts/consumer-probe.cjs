// Proves CommonJS require() works against the packed tarball, on a Node
// version that supports require(esm) (>=20.19.0 or >=22.12.0). This file is
// plain CommonJS regardless of the consumer project's "type": "module",
// because a .cjs extension always forces CommonJS. Run by verify-package.mjs.
const assert = require('node:assert/strict');

const { splitSentences, classifySentence, classifyDocument } = require('grounding-kit');

const sentences = splitSentences('Dr. Alvarez reviewed the unit. It shipped the next day.');
assert.deepEqual(sentences, ['Dr. Alvarez reviewed the unit.', 'It shipped the next day.']);

const evidence = { e1: 'independent lab testing measured 14 hours of battery life' };
const grounded = classifySentence(
  'Battery life reached 14 hours in independent lab testing [[cite:e1]].',
  evidence,
);
assert.equal(grounded.status, 'grounded');

const doc = classifyDocument('The device is waterproof [[cite:e99]].', evidence);
assert.equal(doc.sentences[0].status, 'invalid');

console.log('CommonJS require() probe passed');
