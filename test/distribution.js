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
const marketpoolsPayload = setupContractPayload('marketpools', './contracts/marketpools.js');

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

async function assertDistTokenBalance(id, symbol, balance) {
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

async function setUpEnv(configOverride = {}) {
  let transactions = [];
  let refBlockNumber = fixture.getNextRefBlockNumber();
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(marketpoolsPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
  
  let block = {
    refHiveBlockNumber: refBlockNumber,
    refHiveBlockId: 'ABCD1',
    prevRefHiveBlockId: 'ABCD2',
    timestamp: '2018-05-31T00:00:00',
    transactions,
  };

  await fixture.sendBlock(block);
  await tableAsserts.assertNoErrorInLastBlock();

  transactions = [];
  refBlockNumber = fixture.getNextRefBlockNumber();
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "distribution", "tickAction": "checkPendingDistributions"}'));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));

  block = {
    refHiveBlockNumber: refBlockNumber,
    refHiveBlockId: 'ABCD1',
    prevRefHiveBlockId: 'ABCD2',
    timestamp: '2018-05-31T01:00:00',
    transactions,
  };

  await fixture.sendBlock(block);
  await tableAsserts.assertNoErrorInLastBlock();
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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [], "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "XXX", "quantity": 1}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [{"account": "donchate"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 1},{"account": "harpagon", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": "x"}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": "x"},{"account": "harpagon", "pct": "x"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "harpagon", "pct": 60}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 1},{"symbol": "TKN", "quantity": 2}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 60},{"account": "donchate", "type": "user", "pct": 40}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "marketpool", "numTicks": "30", "tokenPair": "SWAP.HIVE:BEE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "numTicks": "30", "tokenPair": "SWAP.HIVE:BEE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "numTicks": "30", "isSignedWithActiveKey": true }'));

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

      assertError(txs[2], 'you must use a transaction signed with your active key');
      assertError(txs[3], 'invalid strategy');
      assertError(txs[4], 'numTicks must be a number between 1 and 5555');
      assertError(txs[5], 'tokenMinPayout must be an array');
      assertError(txs[6], 'specify at least one minimum payout configuration');
      assertError(txs[7], 'specify at least one minimum payout configuration');
      assertError(txs[8], 'invalid quantity');
      assertError(txs[9], '1-50 tokenRecipients are supported');
      assertError(txs[10], 'invalid quantity');
      assertError(txs[11], 'tokenRecipients pct must total 100');
      assertError(txs[12], 'tokenRecipients type must be user or contract');
      assertError(txs[13], 'invalid quantity');
      assertError(txs[14], 'tokenRecipients type must be user or contract');
      assertError(txs[15], 'tokenRecipients cannot have duplicate accounts');
      assertError(txs[16], 'tokenMinPayout cannot have duplicate symbols');
      assertError(txs[17], 'invalid strategy');
      assertError(txs[18], 'invalid tokenPair');
      assertError(txs[19], 'invalid tokenPair');
      
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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "SWAP.HIVE:BEE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "numTicks": "30", "tokenPair": "SWAP.HIVE:BEE", "numTicks": "30", "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }'));

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
        contract: 'distribution',
        table: 'batches',
        query: {},
      });
      assert.ok(res.length === 2, 'newly created distribution not found');

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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = 1;
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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "SWAP.HIVE:BEE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "numTicks": "30", "tokenPair": "SWAP.HIVE:BEE", "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }'));            

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = 1;
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": 2, "excludeAccount": "donchate", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": 2, "tokenPair": "ABC:DEF", "isSignedWithActiveKey": true }`));

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
      assertError(txs[5], '1-50 tokenRecipients are supported');
      assertError(txs[6], 'invalid quantity');
      assertError(txs[7], 'tokenRecipients type must be user or contract');
      assertError(txs[8], 'tokenRecipients type must be user or contract');
      assertError(txs[9], 'invalid quantity');
      assertError(txs[10], 'tokenRecipients type must be user or contract');
      assertError(txs[11], 'tokenRecipients cannot have duplicate accounts');
      assertError(txs[12], 'tokenMinPayout cannot have duplicate symbols');
      assertError(txs[13], 'excludeAccount must be an array');
      assertError(txs[14], 'invalid tokenPair');

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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "SWAP.HIVE:BEE", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "numTicks": "30", "tokenPair": "SWAP.HIVE:BEE", "numTicks": "30", "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }'));      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      const id = 1;
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 100}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": 2, "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      let res = await fixture.database.find({
        contract: 'distribution',
        table: 'batches',
        query: {},
      });
      assert.ok(res.length === 2, 'distributions not found');
      assert.strictEqual(res[0].tokenMinPayout[0].quantity, 100, 'distribution payout quantity not updated');
      assert.strictEqual(res[0].tokenRecipients[0].pct, 50, 'distribution recipient pct not updated');
      assert.strictEqual(res[0].tokenRecipients.length, 2, 'distribution recipient addition not updated');
      assert.strictEqual(res[1].excludeAccount[0], 'donchate', 'excludeAccount not updated');

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
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
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

      const id = 1;
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true}`));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": false}`));
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
  
  it('should hold payments on deposit not exceeding tokenMinPayout', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
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

      const id = 1;
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
      await assertDistTokenBalance(id, 'TKN', 5);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });    

  it('should flush fixed distribution', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "30", "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
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

      const id = 1;
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
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN', balance: '2.50000000'});

      // contract should be flushed
      await assertDistTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should flush pool distribution', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNA", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));            
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "TKNA:TKNB", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "1", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "10", "quoteQuantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "tokenPair": "TKNA:TKNB", "numTicks": "30", "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', '{ "id": 1, "active": "true", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "BEE", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "TKNA", "quantity": "100", "isSignedWithActiveKey": true }'));
      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'flush', '{ "id": 1, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length === 0, 'Expected to find no virtualTransactions');

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'BEE', balance: '3200.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'BEE', balance: '9.09090909'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'BEE', balance: '90.90909090'});
      await assertDistTokenBalance(1, 'BEE', '0.00000001');

      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '1900.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'TKNA', balance: '2008.09090909'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'TKNA', balance: '3080.90909090'});
      await assertDistTokenBalance(1, 'TKNA', '0.00000001');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should tick fixed strategy batches', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "fixed", "numTicks": "1", "tokenMinPayout": [{"symbol": "TKN", "quantity": "10"},{"symbol": "TKNA", "quantity": "5"}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 25},{"account": "airdrops", "type": "contract", "pct": 25}], "isSignedWithActiveKey": true }'));
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

      const id = 1;
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

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'empty', 'empty', `{ }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      // res = await fixture.database.getLatestBlockInfo();
      // console.log(res);

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKN', balance: '450.00000000'});
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '450.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKN', balance: '25.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dantheman', symbol: 'TKNA', balance: '25.00000000'});
      await assertContractBalance('airdrops', 'TKN', 25);
      await assertContractBalance('airdrops', 'TKNA', 25);

      // contract should be flushed
      await assertDistTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should tick pool strategy batches', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNA", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));            
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "TKNA:TKNB", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "1", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "10", "quoteQuantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "tokenPair": "TKNA:TKNB", "numTicks": "30", "excludeAccount": ["donchate"], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', '{ "id": 1, "active": "true", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "BEE", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "TKNA", "quantity": "100", "isSignedWithActiveKey": true }'));
      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "1", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'BEE', balance: '3200.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'BEE', balance: '0.30303030'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'BEE', balance: '3.03030303'});
      await assertDistTokenBalance(1, 'BEE', '96.66666667');

      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '1899.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'TKNA', balance: '1999.30303030'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'TKNA', balance: '2993.03030303'});
      await assertDistTokenBalance(1, 'TKNA', '96.66666667');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "1", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');

      // should be redistributed
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'BEE', balance: '3200.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'BEE', balance: '0.60606060'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'BEE', balance: '6.06060606'});
      await assertDistTokenBalance(1, 'BEE', '93.33333334');

      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '1898.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'TKNA', balance: '1999.60606060'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'TKNA', balance: '2996.06060606'});
      await assertDistTokenBalance(1, 'TKNA', '93.33333334');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should limit number of transfers per block', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();
      await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'distribution', 'updateParams', '{ "maxTransferLimit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNA", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "donchate", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "2000", "to": "investor", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "3000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "1000", "to": "minnow", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNB", "quantity": "1000", "to": "minnow", "isSignedWithActiveKey": true }'));                              
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'marketpools', 'createPool', '{ "tokenPair": "TKNA:TKNB", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "1", "quoteQuantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "10", "quoteQuantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'minnow', 'marketpools', 'addLiquidity', '{ "tokenPair": "TKNA:TKNB", "baseQuantity": "0.5", "quoteQuantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'create', '{ "strategy": "pool", "tokenPair": "TKNA:TKNB", "numTicks": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'setActive', '{ "id": 1, "active": "true", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "BEE", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'distribution', 'deposit', '{ "id": 1, "symbol": "TKNA", "quantity": "100", "isSignedWithActiveKey": true }'));
      

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'placeholder', 'empty', 'empty', '{}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');

      let pendingRecs = await fixture.database.find({
        contract: 'distribution',
        table: 'pendingPayments',
        query: {},
      });
      // console.log(pendingRecs);
      assert.ok(pendingRecs[0].accounts.length === 5, 'Expected to find pending payments');

      // should pay the first LP record only (transfer limit is 1)
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'BEE', balance: '3200.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'BEE', balance: '8.69565217'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'BEE'});
      await tableAsserts.assertUserBalances({ account: 'minnow', symbol: 'BEE'});
      await assertDistTokenBalance(1, 'BEE', '0.00000002'); // rounding dust

      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '1900.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'TKNA', balance: '1999.00000000'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'TKNA', balance: '2990.00000000'});
      await tableAsserts.assertUserBalances({ account: 'minnow', symbol: 'TKNA', balance: '999.50000000'});
      await assertDistTokenBalance(1, 'TKNA', '0.00000002'); // rounding dust

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'placeholder', 'empty', 'empty', '{}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');

      pendingRecs = await fixture.database.find({
        contract: 'distribution',
        table: 'pendingPayments',
        query: {},
      });
      // console.log(pendingRecs);
      assert.ok(pendingRecs[0].accounts.length === 4, 'Expected to find pending payments');

      // should pay the second LP from pending table (transfer limit is 1)
      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'BEE', balance: '3200.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'BEE', balance: '8.69565217'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'BEE'});
      await tableAsserts.assertUserBalances({ account: 'minnow', symbol: 'BEE'});
      await assertDistTokenBalance(1, 'BEE', '0.00000002');

      await tableAsserts.assertUserBalances({ account: 'donchate', symbol: 'TKNA', balance: '1900.00000000'});
      await tableAsserts.assertUserBalances({ account: 'investor', symbol: 'TKNA', balance: '2007.69565217'});
      await tableAsserts.assertUserBalances({ account: 'whale', symbol: 'TKNA', balance: '2990.00000000'});
      await tableAsserts.assertUserBalances({ account: 'minnow', symbol: 'TKNA', balance: '999.50000000'});
      await assertDistTokenBalance(1, 'TKNA', '0.00000002');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });  

  /// END TESTS
});
