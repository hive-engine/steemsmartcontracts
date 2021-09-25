/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

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

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const contractPayload = setupContractPayload('airdrops', './contracts/airdrops.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertPendingAirdrop(airdropId, reverse = false) {
  const res = await fixture.database.findOne({
    contract: 'airdrops',
    table: 'pendingAirdrops',
    query: {
      airdropId,
    },
  });

  if (!reverse) assert.ok(res, `pendingAirdrop ${airdropId} not found.`);
  else assert.ok(!res, `pendingAirdrop ${airdropId} is unexpected.`);
}

// smart contract
describe('Airdrops Smart Contract', function () {
  this.timeout(20000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done();
      });
  });

  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done();
      });
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done();
      });
  });

  afterEach((done) => {
    // runs after each test in this block
    new Promise(async (resolve) => {
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done();
      });
  });

  it('should not initiate airdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": false, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": 1, "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": 1, "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "liquid_transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN.TEST", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "stake", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [[]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "harpagon"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "-100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100.000000001"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "0.3", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"]] }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[4], 'you must use a custom_json signed with your active key');
      assertError(txs[5], 'invalid params'); // invalid symbol
      assertError(txs[6], 'invalid params'); // invalid type
      assertError(txs[7], 'invalid params'); // invalid list
      assertError(txs[8], 'invalid type');
      assertError(txs[9], 'symbol does not exist');
      assertError(txs[10], 'staking not enabled');
      assertError(txs[11], 'list[0]: account name cannot be undefined');
      assertError(txs[12], 'list[0]: invalid account name');
      assertError(txs[13], 'list[0]: quantity cannot be undefined');
      assertError(txs[14], 'list[0]: invalid quantity');
      assertError(txs[15], 'list[0]: quantity must be positive');
      assertError(txs[16], 'list[0]: quantity precision mismatch');
      assertError(txs[17], 'list cannot be empty');
      assertError(txs[18], 'you must have enough tokens to cover the airdrop fee');
      assertError(txs[20], 'you must have enough tokens to do the airdrop');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should initiate airdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"],["leo.voter", "50"],["aggroed", "50"],["cryptomancer", "30"],["token-raindrops", "20"],["hive-engine", "50"]] }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[5].logs);
      const newAirdropEvent = eventLog.events.find(x => x.event === 'newAirdrop');
      assert.equal(newAirdropEvent.data.airdropId, txs[5].transactionId);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not run airdrop distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const { virtualTransactions } = res;

      assert.ok(!virtualTransactions[0]);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run airdrop distribution with transfer method', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"],["leo.voter", "50"],["aggroed", "50"],["cryptomancer", "30"],["token-raindrops", "20"],["hive-engine", "50"]] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[5].logs);
      const newAirdropEvent = eventLog.events.find(x => x.event === 'newAirdrop');
      assert.equal(newAirdropEvent.data.airdropId, txs[5].transactionId);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getLatestBlockInfo();
      const virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      const airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
      const transferFromContractEvents = virtualEventLog.events.filter(x => x.event === 'transferFromContract');

      assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
      assert.equal(airdropDistributionEvent.data.transactions, 8);
      assert.equal(transferFromContractEvents.length, 8);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId, true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run airdrop distribution with stake method', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "1101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'enableStaking', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "stake", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"],["leo.voter", "50"],["aggroed", "50"],["cryptomancer", "30"],["token-raindrops", "20"],["hive-engine", "50"]] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[6].logs);
      const newAirdropEvent = eventLog.events.find(x => x.event === 'newAirdrop');
      assert.equal(newAirdropEvent.data.airdropId, txs[6].transactionId);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getLatestBlockInfo();
      const virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      const airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
      const stakeFromContractEvents = virtualEventLog.events.filter(x => x.event === 'stakeFromContract');

      assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
      assert.equal(airdropDistributionEvent.data.transactions, 8);
      assert.equal(stakeFromContractEvents.length, 8);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId, true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run airdrop distribution seperated between multiple blocks', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'airdrops', 'updateParams', '{ "maxTransactionsPerBlock": 2 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'airdrops', 'newAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": [["harpagon", "100"],["satoshi", "100"],["theguruasia", "100"],["leo.voter", "50"],["aggroed", "50"],["cryptomancer", "30"],["token-raindrops", "20"],["hive-engine", "50"]] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[6].logs);
      const newAirdropEvent = eventLog.events.find(x => x.event === 'newAirdrop');
      assert.equal(newAirdropEvent.data.airdropId, txs[6].transactionId);

      await assertPendingAirdrop(newAirdropEvent.data.airdropId);

      for (let i = 0; i < 4; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await fixture.sendBlock(block);

        res = await fixture.database.getLatestBlockInfo();
        const virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        const airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
        const transferFromContractEvents = virtualEventLog.events.filter(x => x.event === 'transferFromContract');

        assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
        assert.equal(airdropDistributionEvent.data.transactions, 2);
        assert.equal(transferFromContractEvents.length, 2);

        if (i === 3) await assertPendingAirdrop(newAirdropEvent.data.airdropId, true);
        else await assertPendingAirdrop(newAirdropEvent.data.airdropId);
      }

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
