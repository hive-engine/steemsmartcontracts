const assert = require('assert');

function assertError(tx, message) {
  const logs = JSON.parse(tx.logs);
  assert(logs.errors, `No error in logs. Error expected with message ${message}`);
  assert.equal(logs.errors[0], message, `Error expected with message ${message}. Instead got ${logs.errors[0]}`);
}

module.exports.assertError = assertError;
