const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');

test('exports an express app', () => {
  assert.equal(typeof app.listen, 'function');
});
