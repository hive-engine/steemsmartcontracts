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
const { Resolver } = require('dns');

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const contractPayload = setupContractPayload('nftairdrops', './contracts/nftairdrops.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

// smart contract
describe('NFT Airdrops Smart Contract', function () {
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
    // runs before each test in this block
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

  it('should update parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.3", "maxTransactionsPerAirdrop": 30001, "maxTransactionsPerBlock": 31, "maxAirdropsPerBlock": 3}'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // make sure there were no unexpected errors
      await tableAsserts.assertNoErrorInLastBlock();

      // parameters should have changed to the new values
      const params = await fixture.database.findOne({
        contract: 'nftairdrops',
        table: 'params',
        query: {},
      });

      assert.equal(params.feePerTransaction, '0.3');
      assert.equal(params.maxTransactionsPerAirdrop, 30001);
      assert.equal(params.maxTransactionsPerBlock, 31);
      assert.equal(params.maxAirdropsPerBlock, 3);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": 0.3}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxTransactionsPerAirdrop": "30001"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxTransactionsPerBlock": null}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxAirdropsPerBlock": []}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"wrongKey": "whatever"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.3", "maxTransactionsPerAirdrop": 30001, "maxTransactionsPerBlock": 31, "maxAirdropsPerBlock": 3}'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check parameters remain unchanged
      const params = await fixture.database.findOne({
        contract: 'nftairdrops',
        table: 'params',
        query: {},
      });

      assert.equal(params.feePerTransaction, '0.1');
      assert.equal(params.maxTransactionsPerAirdrop, 50000);
      assert.equal(params.maxTransactionsPerBlock, 50);
      assert.equal(params.maxAirdropsPerBlock, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
