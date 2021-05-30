/* eslint-disable */
const assert = require('assert');
const { MongoClient } = require('mongodb');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tknContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const pegContractPayload = setupContractPayload('hivepegged', './contracts/hivepegged.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

describe('Hive Pegged', function () {
  this.timeout(10000);

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
  
  it(`buys ${CONSTANTS.HIVE_PEGGED_SYMBOL}`, (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.002 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        });

      let balances = res;
      assert.equal(balances[0].balance, 0.001);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.87);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('withdraws HIVE', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.003 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'hivepegged', 'withdraw', '{ "quantity": "0.002", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        });

      let balances = res;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.57);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      res = await fixture.database.find({
          contract: 'hivepegged',
          table: 'withdrawals',
          query: {
          }
        });

      let withdrawals = res;

      assert.equal(withdrawals[0].id, 'TXID00000004-fee');
      assert.equal(withdrawals[0].type, 'HIVE');
      assert.equal(withdrawals[0].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[0].memo, 'fee tx TXID00000004');
      assert.equal(withdrawals[0].quantity, 0.001);

      assert.equal(withdrawals[1].id, 'TXID00000005-fee');
      assert.equal(withdrawals[1].type, 'HIVE');
      assert.equal(withdrawals[1].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[1].memo, 'fee tx TXID00000005');
      assert.equal(withdrawals[1].quantity, 0.009);

      assert.equal(withdrawals[2].id, 'TXID00000006');
      assert.equal(withdrawals[2].type, 'HIVE');
      assert.equal(withdrawals[2].recipient, 'harpagon');
      assert.equal(withdrawals[2].memo, 'withdrawal tx TXID00000006');
      assert.equal(withdrawals[2].quantity, 0.001);

      assert.equal(withdrawals[3].id, 'TXID00000006-fee');
      assert.equal(withdrawals[3].type, 'HIVE');
      assert.equal(withdrawals[3].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[3].memo, 'fee tx TXID00000006');
      assert.equal(withdrawals[3].quantity, 0.001);

      assert.equal(withdrawals[4].id, 'TXID00000007');
      assert.equal(withdrawals[4].type, 'HIVE');
      assert.equal(withdrawals[4].recipient, 'satoshi');
      assert.equal(withdrawals[4].memo, 'withdrawal tx TXID00000007');
      assert.equal(withdrawals[4].quantity, 0.297);

      assert.equal(withdrawals[5].id, 'TXID00000007-fee');
      assert.equal(withdrawals[5].type, 'HIVE');
      assert.equal(withdrawals[5].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[5].memo, 'fee tx TXID00000007');
      assert.equal(withdrawals[5].quantity, 0.003);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not withdraw HIVE', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.003 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.0021", "isSignedWithActiveKey": true }'));

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
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: 'satoshi'
          }
        });

      let balance = res;

      assert.equal(balance.balance, 0.87);
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      res = await fixture.database.find({
          contract: 'hivepegged',
          table: 'withdrawals',
          query: {
            'recipient': 'satoshi'
          }
        });

      let withdrawals = res;
      assert.equal(withdrawals.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
