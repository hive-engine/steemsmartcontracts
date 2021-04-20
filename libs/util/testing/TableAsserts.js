/* eslint-disable max-len */
/* eslint-disable no-console */
const assert = require('assert');

class TableAsserts {
  constructor(fixture) {
    this.fixture = fixture;
  }

  async assertUserBalances({
    account, symbol, balance, stake, pendingUnstake, delegationsOut, delegationsIn,
  }) {
    const res = await this.fixture.database.findOne({
      contract: 'tokens',
      table: 'balances',
      query: {
        account,
        symbol,
      },
    });

    const expectingNoBalance = !balance && !stake && !pendingUnstake && !delegationsOut && !delegationsIn;
    if (expectingNoBalance) {
      assert.ok(!balance, `No balance expected for ${account}, ${symbol}`);
      return;
    }
    assert.ok(res, `No balance for ${account}, ${symbol}`);

    let pass = true;
    if (res.balance !== balance) {
      console.error(`${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
      pass = false;
    }
    if (res.stake !== stake) {
      console.error(`${account} has ${symbol} stake ${res.stake}, expected ${stake}`);
      pass = false;
    }
    if (pendingUnstake && res.pendingUnstake !== pendingUnstake) {
      console.error(`${account} has ${symbol} pendingUnstake ${res.pendingUnstake}, expected ${pendingUnstake}`);
      pass = false;
    }
    if (delegationsIn && res.delegationsIn !== delegationsIn) {
      console.error(`${account} has ${symbol} delegationsIn ${res.delegationsIn}, expected ${delegationsIn}`);
      pass = false;
    }
    if (delegationsOut && res.delegationsOut !== delegationsOut) {
      console.error(`${account} has ${symbol} delegationsOut ${res.delegationsOut}, expected ${delegationsOut}`);
      pass = false;
    }
    if (!pass) {
      assert.fail('Balance mismatch');
    }
  }

  async assertNoErrorInLastBlock() {
    const lastBlock = await this.fixture.database.getLatestBlockInfo();
    const { transactions } = lastBlock;
    for (let i = 0; i < transactions.length; i += 1) {
      const logs = JSON.parse(transactions[i].logs);
      assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
    }
    const { virtualTransactions } = lastBlock;
    for (let i = 0; i < virtualTransactions.length; i += 1) {
      const logs = JSON.parse(virtualTransactions[i].logs);
      assert(!logs.errors, `Virtual Tx #${i} had unexpected error ${logs.errors}`);
    }
  }
}

module.exports.TableAsserts = TableAsserts;
