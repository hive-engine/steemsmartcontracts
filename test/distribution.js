/* eslint-disable */
const assert = require('assert');
const { createVerify } = require('crypto');
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
const contractPayload = setupContractPayload('distribution', './contracts/distribution.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertContractBalance(account, symbol, balance) {
  const res = await fixture.database.findOne({
    contract: 'tokens',
    table: 'contractsBalances',
    query: { account, symbol }
  });

  if (!balance) {
    assert(!res, `Balance found for ${account}, ${symbol}, expected none.`);
    return;
  }
  assert.ok(res, `No balance for ${account}, ${symbol}`);
  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);  
}

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await fixture.database.findOne({
    contract: 'distribution',
    table: 'batches',
    query: {
      _id: id
    }
  });
  if (dist.tokenBalances) {
    for (let i = 0; i <= dist.tokenBalances.length; i += 1) {
      if (dist.tokenBalances[i].symbol === symbol) {
        assert.equal(dist.tokenBalances[i].quantity, balance, `contract ${id} has ${symbol} balance ${dist.tokenBalances[i].quantity}, expected ${balance}`);
        hasBalance = true;
        break;
      }
    }
    if (balance === undefined) {
      assert(!hasBalance, `Balance found for contract ${id}, ${symbol}, expected none.`);
      return;
    }
  }
  assert.ok(hasBalance, `No balance for contract ${id}, ${symbol}`);
}

async function assertAllErrorInLastBlock() {
  const transactions = (await fixture.database.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(logs.errors, `Tx #${i} had unexpected success ${logs.errors}`);
  }
}

async function getLastDistributionId() {
  let blk = await fixture.database.getLatestBlockInfo();
  let eventLog = JSON.parse(blk.transactions[4].logs);
  let createEvent = eventLog.events.find(x => x.event === 'create');
  return createEvent.data.id;
}

// distribution test suite
describe('distribution', function () {
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

  it('should not create invalid distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [], "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX", "quantity": 1}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [{"account": "donchate"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 1},{"account": "harpagon", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": "x"}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": "x"},{"account": "harpagon", "pct": "x"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "harpagon", "pct": 60}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1},{"symbol": "TKN", "quantity": 2}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }'));

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

      assertError(txs[4], 'you must use a transaction signed with your active key');
      assertError(txs[5], 'tokenMinPayout must be an array');
      assertError(txs[6], 'specify at least one minimum payout configuration');
      assertError(txs[7], 'specify at least one minimum payout configuration');
      assertError(txs[8], 'invalid quantity');
      assertError(txs[9], '1-40 tokenRecipients are supported');
      assertError(txs[10], 'invalid quantity');
      assertError(txs[11], 'tokenRecipients pct must total 100');
      assertError(txs[12], 'tokenRecipients type must be user or contract');
      assertError(txs[13], 'invalid quantity');
      assertError(txs[14], 'tokenRecipients type must be user or contract');
      assertError(txs[15], 'tokenRecipients cannot have duplicate accounts');
      assertError(txs[16], 'tokenMinPayout cannot have duplicate symbols');
      
      res = await fixture.database.find({
        contract: 'distribution',
        table: 'batches'
      });
  
      assert.ok(!res, 'invalid distribution created');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should create valid distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      // console.log(blk);
      await tableAsserts.assertNoErrorInLastBlock();
      const id = await getLastDistributionId();
      let res = await fixture.database.findOne({
        contract: 'distribution',
        table: 'batches',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'newly created distribution not found');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should not set distribution active', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": false }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', '{ "id": "1000000", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'scriptkiddie', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      
      assertError(txs[0], 'you must use a custom_json signed with your active key');
      assertError(txs[1], 'distribution id not found');
      assertError(txs[2], 'you must be the creator of this distribution');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update invalid distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": false }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [], "tokenRecipients": 1, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX", "quantity": 1}], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [{"account": "donchate"}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 1}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 1},{"account": "harpagon", "pct": 1}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": "x"}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": "x"},{"account": "harpagon", "pct": "x"}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "harpagon", "pct": 60}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1},{"symbol": "TKN", "quantity": 2}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'you must use a transaction signed with your active key');
      assertError(txs[1], 'tokenMinPayout must be an array');
      assertError(txs[2], 'specify at least one minimum payout configuration');
      assertError(txs[3], 'specify at least one minimum payout configuration');
      assertError(txs[4], 'invalid quantity');
      assertError(txs[5], '1-40 tokenRecipients are supported');
      assertError(txs[6], 'invalid quantity');
      assertError(txs[7], 'tokenRecipients type must be user or contract');
      assertError(txs[8], 'tokenRecipients type must be user or contract');
      assertError(txs[9], 'invalid quantity');
      assertError(txs[10], 'tokenRecipients type must be user or contract');
      assertError(txs[11], 'tokenRecipients cannot have duplicate accounts');
      assertError(txs[12], 'tokenMinPayout cannot have duplicate symbols');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 100}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      let res = await fixture.database.findOne({
        contract: 'distribution',
        table: 'batches',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'distribution not found');
      assert.strictEqual(res.tokenMinPayout[0].quantity, 100, 'distribution payout quantity not updated');
      assert.strictEqual(res.tokenRecipients[0].pct, 50, 'distribution recipient pct not updated');
      assert.strictEqual(res.tokenRecipients.length, 2, 'distribution recipient addition not updated');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not accept deposits when inactive or invalid', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": 100, "isSignedWithActiveKey": true}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'distribution must be active to deposit');

      // should still be as initialized
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '500'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": 100, "isSignedWithActiveKey": false}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100x", "isSignedWithActiveKey": true}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = await fixture.database.getLatestBlockInfo();
      txs = res.transactions;

      assertError(txs[1], 'you must use a custom_json signed with your active key');
      assertError(txs[2], 'invalid quantity');

      // should still be as initialized
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '500'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN'});
     
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should distribute payments on deposit exceeding tokenMinPayout', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // should be no errors
      await tableAsserts.assertNoErrorInLastBlock();

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '450.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN', balance: '50.000'});

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
  
  it('should hold payments on deposit not exceeding tokenMinPayout', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // should be no errors
      await tableAsserts.assertNoErrorInLastBlock();

      // should be as initialized
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '495.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN'});

      // should have tokenBalance
      await assertTokenBalance(id, 'TKN', 5);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });    

  it('should distribute payments on flush', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'flush', `{ "id": ${id}, "symbol": "TKN", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // should be no errors
      await tableAsserts.assertNoErrorInLastBlock();

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '497.50000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN', balance: '2.500'});

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should distribute payments to both users and contracts for multiple tokens', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10},{"symbol": "TKNA", "quantity": 5}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 25},{"account": "airdrops", "type": "contract", "pct": 25}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNA", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKNA", "quantity": "100", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      // should be no errors
      await tableAsserts.assertNoErrorInLastBlock();

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '450.00000000'});
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '450.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN', balance: '25.000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKNA', balance: '25.000'});
      await assertContractBalance('airdrops', 'TKN', 25);
      await assertContractBalance('airdrops', 'TKNA', 25);

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  
});
