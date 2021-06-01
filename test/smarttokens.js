/* eslint-disable */
const assert = require('assert');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const contractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const oldContractPayload = setupContractPayload('tokens', './contracts/testing/tokens_20200923.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const tokenfundsContractPayload = setupContractPayload('tokenfunds', './contracts/tokenfunds.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertTotalStaked(amount, symbol='TKN') {
  let res = await fixture.database.findOne({
    contract: 'tokens',
    table: 'tokens',
    query: {
      symbol,
    },
  });

  assert.equal(res.totalStaked, amount, `${symbol} has ${res.totalStaked} staked, expected ${amount}`);
}

async function assertPendingUnstake({ account, symbol, quantity, nextTransactionTimestamp, txID }) {
  let unstake = await fixture.database.findOne({
    contract: 'tokens',
    table: 'pendingUnstakes',
    query: {
      account,
      symbol,
    }
  });
  assert.equal(unstake.symbol, symbol);
  assert.equal(unstake.account, account);
  assert.equal(unstake.quantity, quantity);
  assert.equal(unstake.nextTransactionTimestamp, nextTransactionTimestamp);
  assert.equal(unstake.txID, txID);
}

async function assertNoPendingUnstake(account, symbol) {
  let unstake = await fixture.database.findOne({
    contract: 'tokens',
    table: 'pendingUnstakes',
    query: {
      account,
      symbol,
    }
  });
  assert(!unstake);
}

async function assertParams(key, value) {
    let res = await fixture.database.findOne({
        contract: 'tokens',
        table: 'params',
        query: {},
    });
    assert.equal(res[key], value, `Params for ${key} is ${res[key]}, expected ${value}`);
}

// smart tokens
describe('smart tokens', function () {
  this.timeout(30000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done()
      })
  });

  afterEach((done) => {
      // runs after each test in this block
      new Promise(async (resolve) => {
        await db.dropDatabase()
        resolve();
      })
        .then(() => {
          done()
        })
  });

  it('should enable delegation', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      );

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);
      assert.equal(token.delegationEnabled, true);
      assert.equal(token.undelegationCooldown, 7);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not enable delegation', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18250, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18250, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 0, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18251, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assertError(txs[4], 'staking not enabled');
      assertError(txs[6], 'you must have enough tokens to cover  fees');
      assertError(txs[8], 'must be the issuer');
      assertError(txs[9], 'undelegationCooldown must be an integer between 1 and 18250');
      assertError(txs[10], 'undelegationCooldown must be an integer between 1 and 18250');
      assertError(txs[12], 'delegation already enabled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should delegate tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "99.99999999",
          stake: "0.00000000",
          delegationsOut: "0.00000001",
      });
      await tableAsserts.assertUserBalances({
          account: 'vitalik',
          symbol: 'TKN',
          balance: "0",
          stake: "0",
          delegationsIn: "0.00000001",
      });
      await assertTotalStaked('0.00000001');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      let delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "99.99999996",
          stake: "0.00000000",
          delegationsOut: "0.00000004",
      });
      await tableAsserts.assertUserBalances({
          account: 'vitalik',
          symbol: 'TKN',
          balance: "0",
          stake: "0",
          delegationsIn: "0.00000003",
      });
      await tableAsserts.assertUserBalances({
          account: 'ned',
          symbol: 'TKN',
          balance: "100",
          stake: "0",
          delegationsIn: "0.00000001",
      });

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000003');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not delegate tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "NKT", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.000000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ned', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[6], 'invalid to');
      assertError(txs[7], 'symbol does not exist');
      assertError(txs[8], 'symbol precision mismatch');
      assertError(txs[9], 'delegation not enabled');
      assertError(txs[11], 'must delegate positive quantity');
      assertError(txs[12], 'balanceFrom does not exist');
      assertError(txs[13], 'overdrawn stake');
      assertError(txs[14], 'cannot delegate to yourself');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 100);
      assert.equal(balance.stake, 0);
      assert.equal(balance.delegationsOut, 0);
      assert.equal(balance.delegationsIn, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      let res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        });

      let balances = res;
      balances.sort((a, b) => a._id - b._id);

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999997");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000003");
      assert.equal(balances[0].pendingUndelegations, '0');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000002");

      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].account, 'ned');
      assert.equal(balances[2].balance, "0");
      assert.equal(balances[2].stake, "0");
      assert.equal(balances[2].delegationsIn, "0.00000001");

      await assertTotalStaked('0.00000003');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      let delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000002');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "99.99999997",
          stake: "0.00000000",
          delegationsOut: "0.00000002",
          pendingUndelegations: '0.00000001'});

      await tableAsserts.assertUserBalances({
          account: 'vitalik',
          balance: '0',
          stake: '0',
          delegationsIn: '0.00000001',
          pendingUndelegations: '0'});

      await assertTotalStaked('0.00000003');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let pendingUndelegations = res;

      assert.equal(pendingUndelegations.length, 1);
      assert.equal(pendingUndelegations[0].symbol, 'TKN');
      assert.equal(pendingUndelegations[0].account, 'satoshi');
      assert.equal(pendingUndelegations[0].quantity, '0.00000001');
      let blockDate = new Date('2018-06-01T00:00:01.000Z')
      assert.equal(pendingUndelegations[0].completeTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(pendingUndelegations[0].txID);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "ned", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "99.99999997",
          stake: "0.00000000",
          delegationsOut: "0.00000001",
          pendingUndelegations: '0.00000002'});

      await tableAsserts.assertUserBalances({
          account: 'ned',
          balance: '0',
          stake: '0',
          delegationsIn: '0.00000000',
          pendingUndelegations: '0'});

      await assertTotalStaked('0.00000003');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      delegations = res;

      assert.equal(delegations.length, 1);

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      pendingUndelegations = res;

      assert.equal(pendingUndelegations.length, 2);
      assert.equal(pendingUndelegations[0].symbol, 'TKN');
      assert.equal(pendingUndelegations[0].account, 'satoshi');
      assert.equal(pendingUndelegations[0].quantity, '0.00000001');
      blockDate = new Date('2018-06-01T00:00:01.000Z')
      assert.equal(pendingUndelegations[0].completeTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(pendingUndelegations[0].txID);

      assert.equal(pendingUndelegations[1].symbol, 'TKN');
      assert.equal(pendingUndelegations[1].account, 'satoshi');
      assert.equal(pendingUndelegations[1].quantity, '0.00000001');
      blockDate = new Date('2018-06-02T00:00:01.000Z')
      assert.equal(pendingUndelegations[1].completeTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(pendingUndelegations[1].txID);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "NKT", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.000000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ned', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000004", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[5].logs).errors[0], 'invalid from');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'delegation not enabled');
      assert.equal(JSON.parse(txs[10].logs).errors[0], 'must undelegate positive quantity');
      assert.equal(JSON.parse(txs[11].logs).errors[0], 'balanceTo does not exist');
      assert.equal(JSON.parse(txs[12].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[16].logs).errors[0], 'balanceFrom does not exist');
      assert.equal(JSON.parse(txs[18].logs).errors[0], 'delegation does not exist');
      assert.equal(JSON.parse(txs[20].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[21].logs).errors[0], 'cannot undelegate from yourself');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should process the pending undelegations', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: '99.99999997',
          stake: '0.00000001',
          delegationsIn: '0',
          delegationsOut: '0.00000002',
          pendingUndelegations: '0.00000000'});
      await tableAsserts.assertUserBalances({
          account: 'vitalik',
          symbol: 'TKN',
          balance: '0',
          stake: '0',
          delegationsIn: '0.00000001',
          delegationsOut: '0',
          pendingUndelegations: '0'});

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let undelegation = res;

      assert.equal(undelegation, null);

      res = await fixture.database.getLatestBlockInfo();

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'undelegateDone');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should enable staking', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not enable staking', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 0, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 18251, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, false);
      assert.equal(token.unstakingCooldown, 1);

      res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'you must have enough tokens to cover  fees');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 18250');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 18250');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not enable staking again', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 10, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      assertError(txs[4], 'staking already enabled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"vitalik", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);


      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik']
            },
            symbol: 'TKN'
          }
        });

      let balances = res;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, '99.99999997');
      assert.equal(balances[0].stake, '0.00000002');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, 0);
      assert.equal(balances[1].stake, '0.00000001');

      res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[0].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[0].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.account, 'satoshi');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.symbol, 'TKN');

      assert.equal(JSON.parse(txs[1].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[1].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.account, 'vitalik');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.symbol, 'TKN');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

      await assertTotalStaked('0.00000003');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not stake tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"ez", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "100.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'must stake positive quantity');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(txs[9].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should start the unstake process', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      assert.equal(unstake.quantityLeft, '0.00000001');
      assert.equal(unstake.numberTransactionsLeft, 1);
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(unstake.txID);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not start the unstake process', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must unstake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

            resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not start the unstake process multi tx', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 14, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi", "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "0.00000000",
          stake: "50.00000000",
          pendingUnstake: "100.00000000",
      });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({
          account: 'satoshi',
          symbol: 'TKN',
          balance: "0.00000000",
          stake: "50.00000000",
          pendingUnstake: "100.00000000",
      });

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      assert.equal(JSON.parse(txs[0].logs).errors[0], 'overdrawn stake');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      await assertTotalStaked('0.00000001');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);


      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      await assertTotalStaked(0);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(unstake.txID)

      const unstakeId = unstake.txID;

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000000');

      await assertTotalStaked('0.00000001');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should cancel a multi tx unstake', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 14, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'tokens', 'stake', '{ "to":"satoshi2", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: "99.99999997", stake: "0.00000003" });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: "99.99999997", stake: "0.00000003" });

      await assertTotalStaked('0.00000006');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      const unstakeId = fixture.getNextTxId();
      const unstakeId2 = fixture.getNextTxId();
      transactions.push(new Transaction(refBlockNumber, unstakeId, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, unstakeId2, 'satoshi2', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '99.99999997', stake: '0.00000002', pendingUnstake: '0.00000003' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '99.99999997', stake: '0.00000002', pendingUnstake: '0.00000003' });

      await assertTotalStaked('0.00000004');

      await assertPendingUnstake({ account: 'satoshi', symbol: 'TKN', quantity: '0.00000003', nextTransactionTimestamp: new Date('2018-07-07T00:02:00.000Z').getTime(), txID: unstakeId})
      await assertPendingUnstake({ account: 'satoshi2', symbol: 'TKN', quantity: '0.00000003', nextTransactionTimestamp: new Date('2018-07-07T00:02:00.000Z').getTime(), txID: unstakeId2})

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '99.99999997', stake: '0.00000003', pendingUnstake: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '99.99999998', stake: '0.00000000', pendingUnstake: '0.00000002' });

      await assertTotalStaked('0.00000003');

      await assertNoPendingUnstake('satoshi', 'TKN');
      await assertPendingUnstake({ account: 'satoshi2', symbol: 'TKN', quantity: '0.00000003', nextTransactionTimestamp: new Date('2018-07-14T00:02:00.000Z').getTime(), txID: unstakeId2})

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId2}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:03:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '99.99999997', stake: '0.00000003', pendingUnstake: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '99.99999998', stake: '0.00000002', pendingUnstake: '0.00000000' });

      await assertTotalStaked('0.00000005');

      await assertNoPendingUnstake('satoshi2', 'TKN');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      await assertTotalStaked("0.00000001");

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);


      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');
      await assertTotalStaked(0);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      let blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(unstake.txID);

      const unstakeId = unstake.txID;

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "NOTXID12378", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000000');
      assert.equal(balance.pendingUnstake, '0.00000001');
      await assertTotalStaked(0);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(unstake.txID);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should process the pending unstakes', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      await assertTotalStaked('0.00000001');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);


      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 7));
      assert.ok(unstake.txID);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      res = await fixture.database.getLatestBlockInfo();

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      await assertTotalStaked(0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should process the pending unstakes (with multi transactions)', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000008", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999992");
      assert.equal(balance.stake, "0.00000008");

      await assertTotalStaked('0.00000008');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000006", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999992');
      assert.equal(balance.stake, '0.00000006');
      assert.equal(balance.pendingUnstake, '0.00000006');

      await assertTotalStaked('0.00000006');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000006');
      assert.equal(unstake.numberTransactionsLeft, 3);
      let blockDate = new Date('2018-07-01T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 1));
      assert.ok(unstake.txID);

      const unstakeId = unstake.txID;

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999994');
      assert.equal(balance.stake, '0.00000004');
      assert.equal(balance.pendingUnstake, '0.00000004');

      await assertTotalStaked('0.00000004');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000004');
      assert.equal(unstake.numberTransactionsLeft, 2);
      blockDate = new Date('2018-07-02T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 1));
      assert.equal(unstake.txID, unstakeId);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999996');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000002');

      await assertTotalStaked('0.00000002');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000002');
      assert.equal(unstake.numberTransactionsLeft, 1);
      blockDate = new Date('2018-07-03T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setUTCDate(blockDate.getUTCDate() + 1));
      assert.equal(unstake.txID, unstakeId);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000');

      await assertTotalStaked('0.00000002');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);



      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not delegate tokens with unstaking', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "0.00000009", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000003", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      assertError(txs[8], 'overdrawn stake');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999991');
      assert.equal(balance.stake, '0.00000006');
      assert.equal(balance.pendingUnstake, '0.00000007');
      assert.equal(balance.delegationsOut, '0.00000001');
      assert.equal(balance.delegationsIn, 0);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = await fixture.database.getLatestBlockInfo();
      txs = res.transactions;
      assertError(txs[0], 'overdrawn stake');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999993');
      assert.equal(balance.stake, '0.00000003');
      assert.equal(balance.pendingUnstake, '0.00000005');
      assert.equal(balance.delegationsOut, '0.00000002');
      assert.equal(balance.delegationsIn, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

});
