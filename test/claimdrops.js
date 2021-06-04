/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

const assert = require('assert');
const BigNumber = require('bignumber.js');
const { MongoClient } = require('mongodb');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const contractPayload = setupContractPayload('claimdrops', './contracts/claimdrops.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertClaimdrop(claimdropId, reverse = false) {
  const res = await fixture.database.findOne({
    contract: 'claimdrops',
    table: 'claimdrops',
    query: {
      claimdropId,
    },
  });

  if (!reverse) assert.ok(res, `claimdrop ${claimdropId} not found.`);
  else assert.ok(!res, `claimdrop ${claimdropId} is unexpected.`);
}

async function assertClaimdropPool(claimdropId, pool) {
  const res = await fixture.database.findOne({
    contract: 'claimdrops',
    table: 'claimdrops',
    query: {
      claimdropId,
    },
  });

  assert(res, `claimdrop ${claimdropId} not found.`);
  assert(BigNumber(res.remainingPool).eq(pool), 'claimdrop pool incorrect');
}

async function assertBalance(account, balance, symbol, type) {
  const res = await fixture.database.findOne({
    contract: 'tokens',
    table: (type === 'contract') ? 'contractsBalances' : 'balances',
    query: {
      account,
      symbol,
    },
  });

  assert(res, `No Balance found for ${type} ${account}.`);
  assert(BigNumber(res.balance).eq(balance), `${account} Balance: ${res.balance} ${symbol}, Expected ${balance} ${symbol}`);
}

// smart contract
describe('Claimdrops Smart Contract', function () {
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

  it('should not create claimdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": 0.001 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": 1000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": "500" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": 50 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1", "list": ["ali-h", "1000"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN.TEST", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "-0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.000000001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "-1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1.0000000001", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": -100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2000-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "in two days", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2030-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "lol", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "542", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "tkns", "ownerType": "contract", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "60", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "-1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "0.0005" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["", ""]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["0ali--h", ""]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", ""]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", "SEVEN"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", "-50"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", "2.00005"]] }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[4], 'you must use a custom_json signed with your active key');
      assertError(txs[5], 'invalid params'); // invalid symbol
      assertError(txs[6], 'invalid params'); // invalid price
      assertError(txs[7], 'invalid params'); // invalid pool
      assertError(txs[8], 'invalid params'); // invalid maxClaims
      assertError(txs[9], 'invalid params'); // invalid expiry
      assertError(txs[10], 'invalid params'); // invalid owner
      assertError(txs[11], 'invalid params'); // invalid ownerType
      assertError(txs[12], 'invalid params'); // without limit & list
      assertError(txs[13], 'invalid params'); // invalid limit
      assertError(txs[14], 'invalid params'); // invalid list
      assertError(txs[15], 'invalid params'); // with both limit & list
      assertError(txs[16], 'symbol does not exist');
      assertError(txs[17], 'price must be positive');
      assertError(txs[18], 'price precision mismatch');
      assertError(txs[19], 'pool must be positive');
      assertError(txs[20], 'pool precision mismatch');
      assertError(txs[21], 'maxClaims must be positive number');
      assertError(txs[22], 'invalid expiry'); // already exprired according to blockTime
      assertError(txs[23], 'invalid expiry'); // invalid expiry
      assertError(txs[24], 'expiry exceeds limit');
      assertError(txs[25], 'invalid ownerType');
      assertError(txs[26], 'invalid owner'); // invalid username
      assertError(txs[27], 'invalid owner'); // invalid contract name
      assertError(txs[28], 'you must have enough tokens to cover the creation fee');
      assertError(txs[30], 'you must have enough tokens to cover the claimdrop pool');
      assertError(txs[32], 'limit must be positive');
      assertError(txs[33], 'limit precision mismatch');
      assertError(txs[34], 'list cannot be empty');
      assertError(txs[35], 'list[0]: account name cannot be undefined');
      assertError(txs[36], 'list[0]: invalid account name');
      assertError(txs[37], 'list[0]: limit cannot be undefined');
      assertError(txs[38], 'list[0]: invalid limit');
      assertError(txs[39], 'list[0]: limit must be positive');
      assertError(txs[40], 'list[0]: limit precision mismatch');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should create a claimdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", "9.999"], ["thesim", "5000"], ["harpagon", "500.2"]] }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[5].logs);
      const claimdropEvent = eventLog.events.find(x => x.event === 'create');
      assert.equal(claimdropEvent.data.claimdropId, txs[5].transactionId);

      await assertClaimdrop(claimdropEvent.data.claimdropId);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not claim', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "100000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "10000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "10000000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": false, "claimdropId": "claimdrop-0", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": 0, "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-0", "quantity": 1000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-0", "quantity": "1" }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop-0', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 1, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "dave", "quantity": "0.001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-0", "quantity": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-0", "quantity": "1" }')); // maxClaims reaches
      transactions.push(new Transaction(refBlockNumber, 'claimdrop-1', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 2, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1", "quantity": "-1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1", "quantity": "0.0000000005" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "dave", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop-2', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "3000", "maxClaims": 3, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "limit": "2000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "5000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "dave", "quantity": "2.5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "1500" }')); // exceed limit
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-2", "quantity": "1000" }')); // reached limit
      transactions.push(new Transaction(refBlockNumber, 'claimdrop-3', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "3000", "maxClaims": 3, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["mrok", "2000"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "mrok", "quantity": "3", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "dave", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-3", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'mrok', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-3", "quantity": "2500" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'mrok', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-3", "quantity": "2000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'mrok', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-3", "quantity": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'mrok', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-3", "quantity": "0.00000001" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[5], 'you must use a custom_json signed with your active key');
      assertError(txs[6], 'invalid params'); // invalid claimdropId
      assertError(txs[7], 'invalid params'); // invalid quantity
      assertError(txs[8], 'claimdrop does not exist or has been expired');
      assertError(txs[12], 'maximum claims limit has been reached');
      assertError(txs[14], 'quantity must be positive');
      assertError(txs[15], 'quantity precision mismatch');
      assertError(txs[18], 'pool limit has been reached');
      assertError(txs[20], 'quantity exceeds pool');
      assertError(txs[21], 'you must have enough tokens to cover the price');
      assertError(txs[24], 'quantity exceeds your limit');
      assertError(txs[26], 'you have reached your limit');
      assertError(txs[30], 'you are not eligible');
      assertError(txs[31], 'quantity exceeds your limit'); // with list
      assertError(txs[33], 'you have reached your limit'); // with list
      assertError(txs[34], 'quantity too low');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should claim', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "tokens", "ownerType": "contract", "list": [["ali-h", "249.999"], ["thesim", "499.999"], ["harpagon", "1000"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "ali-h", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "thesim", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "harpagon", "quantity": "1", "isSignedWithActiveKey": true }`));

      // claims
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop", "quantity": "249" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thesim', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop", "quantity": "400" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop", "quantity": "200.999" }')); // 150.001 in pool should be remaining after this

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const eventLog = JSON.parse(txs[5].logs);
      const claimdropEvent = eventLog.events.find(x => x.event === 'create');
      assert.equal(claimdropEvent.data.claimdropId, txs[5].transactionId);

      await assertClaimdrop(claimdropEvent.data.claimdropId);
      assert((JSON.parse(txs[9].logs)).events.find(x => x.event === 'claim'), 'expected a claim event');
      assert((JSON.parse(txs[10].logs)).events.find(x => x.event === 'claim'), 'expected a claim event');
      assert((JSON.parse(txs[11].logs)).events.find(x => x.event === 'claim'), 'expected a claim event');

      await assertClaimdropPool(claimdropEvent.data.claimdropId, '150.001');
      await assertBalance('ali-h', '249', 'TKN');
      await assertBalance('ali-h', '0.751', 'SWAP.HIVE');
      await assertBalance('thesim', '400', 'TKN');
      await assertBalance('thesim', '0.6', 'SWAP.HIVE');
      await assertBalance('harpagon', '200.999', 'TKN');
      await assertBalance('harpagon', '0.799001', 'SWAP.HIVE');
      await assertBalance('tokens', '0.849999', 'SWAP.HIVE', 'contract');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not expire claimdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "tokens", "ownerType": "contract", "list": [["ali-h", "249.999"], ["thesim", "499.999"], ["harpagon", "1000"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dave', 'claimdrops', 'expire', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();

      assertError(res.transactions[6], 'not authorized');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should expire claimdrop automatically', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "ali-h", "ownerType": "user", "list": [["ali-h", "249.999"], ["thesim", "499.999"], ["harpagon", "1000"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "thesim", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thesim', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop", "quantity": "200" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await assertClaimdrop('claimdrop');
      await assertBalance('ali-h', '0', 'TKN');
      await tableAsserts.assertNoErrorInLastBlock();

      // expire here automatically (on the next claim)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thesim', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop", "quantity": "200" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-12-01T00:00:00', // expiration time
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();

      const EventLog = JSON.parse(res.transactions[0].logs);
      const claimdropExpirationEvent = EventLog.events.find(x => x.event === 'expire');
      assert(claimdropExpirationEvent && claimdropExpirationEvent.data.claimdropId === 'claimdrop', 'expected to find expiration event');

      await assertClaimdrop('claimdrop', true);
      await assertBalance('ali-h', '800', 'TKN'); // check if the balance has returned (200 TKN was claimed)

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should expire claimdrop manually', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      // expire here manually (by the sender)
      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'claimdrop-1', 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "owner": "dave", "ownerType": "user", "list": [["ali-h", "249.999"], ["thesim", "499.999"], ["harpagon", "1000"]] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.HIVE_PEGGED_SYMBOL}", "to": "thesim", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thesim', 'claimdrops', 'claim', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1", "quantity": "200" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'claimdrops', 'expire', '{ "isSignedWithActiveKey": true, "claimdropId": "claimdrop-1" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      const EventLog = JSON.parse(res.transactions[8].logs);
      const claimdropExpirationEvent = EventLog.events.find(x => x.event === 'expire');
      assert(claimdropExpirationEvent && claimdropExpirationEvent.data.claimdropId === 'claimdrop-1', 'expected to find expiration event');

      await assertClaimdrop('claimdrop', true);
      await assertBalance('dave', '800', 'TKN'); // check if the balance has returned (200 TKN was claimed)

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
