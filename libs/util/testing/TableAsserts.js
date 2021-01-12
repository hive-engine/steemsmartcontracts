const assert = require('assert');

class TableAsserts {
  constructor(fixture) {
    this.fixture = fixture;
  }
    
  async assertUserBalances({ account, symbol, balance, stake, pendingUnstake, delegationsOut, delegationsIn }) {
    let res = await this.fixture.database.findOne({
        contract: 'tokens',
        table: 'balances',
        query: {
          account,
          symbol,
        }
      });

    assert.ok(res, `No balance for ${account}, ${symbol}`);

    assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
    assert.equal(res.stake, stake, `${account} has ${symbol} stake ${res.stake}, expected ${stake}`);
    if (pendingUnstake)
      assert.equal(res.pendingUnstake, pendingUnstake, `${account} has ${symbol} pendingUnstake ${res.pendingUnstake}, expected ${pendingUnstake}`);
    if (delegationsIn)
      assert.equal(res.delegationsIn, delegationsIn, `${account} has ${symbol} delegationsIn ${res.delegationsIn}, expected ${delegationsIn}`);
    if (delegationsOut)
      assert.equal(res.delegationsOut, delegationsOut, `${account} has ${symbol} delegationsOut ${res.delegationsOut}, expected ${delegationsOut}`);
  }

  async assertNoErrorInLastBlock() {
    const lastBlock = await this.fixture.database.getLatestBlockInfo();
    const transactions = lastBlock.transactions;
    for (let i = 0; i < transactions.length; i++) {
      const logs = JSON.parse(transactions[i].logs);
      assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
    }
    const virtualTransactions = lastBlock.virtualTransactions;
    for (let i = 0; i < virtualTransactions.length; i++) {
      const logs = JSON.parse(virtualTransactions[i].logs);
      assert(!logs.errors, `Virtual Tx #${i} had unexpected error ${logs.errors}`);
    }
  }
}

module.exports.TableAsserts = TableAsserts;
