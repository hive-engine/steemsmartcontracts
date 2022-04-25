/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

const assert = require('assert');
const BigNumber = require('bignumber.js');

const { MongoClient } = require('mongodb');
const { CONSTANTS } = require('../libs/Constants');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const contractPayload = setupContractPayload('nftairdrops', './contracts/nftairdrops.js');

// prepare test contract for creating airdrops via another contract
const testSmartContractCode = `
  actions.createSSC = function (payload) {
    // Initialize the smart contract via the create action
  }

  actions.doAirdrop = async function (payload) {
    await api.executeSmartContract('nftairdrops', 'newAirdrop', payload);
  }
`;
base64ContractCode = Base64.encode(testSmartContractCode);

const testContractPayload = {
  name: 'testcontract',
  params: '',
  code: base64ContractCode,
};

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', `{
        "feePerTransaction": "0.3",
        "maxTransactionsPerAirdrop": 30001,
        "maxTransactionsPerAccount": 11,
        "maxTransactionsPerBlock": 31,
        "maxAirdropsPerBlock": 3,
        "processingBatchSize": 33,
        "enabledFromTypes": ["user", "contract"]
      }`));

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

      assert.strictEqual(params.feePerTransaction, '0.3');
      assert.strictEqual(params.maxTransactionsPerAirdrop, 30001);
      assert.strictEqual(params.maxTransactionsPerAccount, 11);
      assert.strictEqual(params.maxTransactionsPerBlock, 31);
      assert.strictEqual(params.maxAirdropsPerBlock, 3);
      assert.strictEqual(params.processingBatchSize, 33);
      assert.ok(params.enabledFromTypes[0] === 'user' && params.enabledFromTypes[1] === 'contract');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxTransactionsPerAccount": -3}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxTransactionsPerAccount": 50001}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxTransactionsPerBlock": -3}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"maxAirdropsPerBlock": []}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"processingBatchSize": 0}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"enabledFromTypes": ["user", "whatever"]}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"enabledFromTypes": []}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"enabledFromTypes": null}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"wrongKey": "whatever"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.3", "maxTransactionsPerAirdrop": 30001, "maxTransactionsPerBlock": 31, "maxAirdropsPerBlock": 3}'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[1],  'invalid feePerTransaction');
      assertError(txs[2],  'invalid maxTransactionsPerAirdrop');
      assertError(txs[3],  'invalid maxTransactionsPerAccount'); // maxTransactionsPerAccount > 0
      assertError(txs[4],  'invalid maxTransactionsPerAccount'); // maxTransactionsPerAccount <= params.maxTransactionsPerAirdrop
      assertError(txs[5],  'invalid maxTransactionsPerBlock');
      assertError(txs[6],  'invalid maxAirdropsPerBlock');
      assertError(txs[7],  'invalid processingBatchSize');
      assertError(txs[8],  'invalid enabledFromTypes'); // wrong value in array
      assertError(txs[9],  'invalid enabledFromTypes'); // empty array
      assertError(txs[10], 'invalid enabledFromTypes'); // wrong type
      assertError(txs[12], 'not authorized');

      // check parameters remain unchanged
      const params = await fixture.database.findOne({
        contract: 'nftairdrops',
        table: 'params',
        query: {},
      });

      assert.strictEqual(params.feePerTransaction, '0.1');
      assert.strictEqual(params.maxTransactionsPerAirdrop, 50000);
      assert.strictEqual(params.maxTransactionsPerAccount, 50);
      assert.strictEqual(params.maxTransactionsPerBlock, 50);
      assert.strictEqual(params.maxAirdropsPerBlock, 1);
      assert.ok(params.enabledFromTypes.length === 1 && params.enabledFromTypes[0] === 'user');
      assert.strictEqual(('wrongKey' in params), false);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should initiate airdrop and run distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.15", "maxTransactionsPerAirdrop": 10, "maxTransactionsPerAccount": 3, "maxTransactionsPerBlock": 4, "maxAirdropsPerBlock": 2, "processingBatchSize": 5}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "nftairdrops", "tickAction": "tick" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "bennierex", "quantity": "1984", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT", "symbol": "TSTNFT", "url": "http://mynft.com", "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "blue"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "orange"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "yellow"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "red"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "purple"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "green"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "white"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "grey"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "black"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "transparent"} }
      ] }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      const transactionId = fixture.getNextTxId();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, transactionId, 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1", "2"] },
        { "to": "aggroed", "ids": ["3", "4"] },
        { "to": "cryptomancer", "ids": ["5", "6", "7"] },
        { "to": "nftmarket", "toType": "contract", "ids": ["8", "9", "10"] }
      ] }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      }

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      // Check if the fee has been burned.
      const blockInfo = await fixture.database.getLatestBlockInfo();
      const eventLog = JSON.parse(blockInfo.transactions[0].logs).events;
      assert.ok(eventLog.find(x => {
        return (
          x.contract === 'tokens'
          && x.event === 'transfer'
          && x.data.from === 'bennierex'
          && x.data.to === 'null'
          && x.data.symbol === `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`
          && x.data.quantity === '1.50000000');
      }), 'could not verify fee was burned');

      // Make sure all expected NFTs have been transferred to the contract.
      let nftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {
          _id: { $in: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          account: 'nftairdrops',
          ownedBy: 'c',
        }
      });
      assert.strictEqual(nftInstances.length, 10);

      // Check if airdrop has been correctly added to the database.
      let pendingAirdrop = await fixture.database.findOne({
        contract: 'nftairdrops',
        table: 'pendingAirdrops',
        query: {},
      });
      assert.strictEqual(pendingAirdrop.isValid, true);
      assert.strictEqual(pendingAirdrop.softFail, true);
      assert.strictEqual(pendingAirdrop.blockNumber, 3);
      assert.strictEqual(pendingAirdrop.airdropId, transactionId);
      assert.strictEqual(pendingAirdrop.symbol, 'TSTNFT');
      assert.strictEqual(pendingAirdrop.from, 'bennierex');
      assert.strictEqual(pendingAirdrop.fromType, 'user');
      assert.strictEqual(pendingAirdrop.list.length, 4);
      assert.strictEqual(pendingAirdrop.nftIds.length, 10);
      assert.strictEqual(pendingAirdrop.nftIds.every((val, idx) => val === ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'][idx]), true);
      assert.strictEqual(pendingAirdrop.totalFee, '1.50000000');

      // Assert airdrop execution for the next three blocks.
      for (let i = 0; i < 3; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'whatever', 'whatever', '')); // No-op to force block creation.
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD2',
          prevRefHiveBlockId: 'ABCD1',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        }
        await fixture.sendBlock(block);

        const blockInfo = await fixture.database.getLatestBlockInfo();
        const virtualEventLog = JSON.parse(blockInfo.virtualTransactions[0].logs).events;
        const nftAirdropDistributionEvent = virtualEventLog.find(x => x.event === 'nftAirdropDistribution');
        const nftAirdropFinishedEvent = virtualEventLog.find(x => x.event === 'nftAirdropFinished');
        const nftAirdropFailedEvent = virtualEventLog.find(x => x.event === 'nftAirdropFailed');
        const nftTransferEvents = virtualEventLog.filter(x => x.event === 'transfer');
        assert.ok(nftAirdropDistributionEvent, 'expected airdropDistribution event');
        if (i < 2) {
          assert.strictEqual(nftAirdropDistributionEvent.data.transactionCount, 4);
          assert.strictEqual(nftTransferEvents.length, 4);
          assert.strictEqual(nftAirdropFailedEvent, undefined, 'did not expect nftAirdropFailed event');
          assert.strictEqual(nftAirdropFinishedEvent, undefined, 'did not expect nftAirdropFinished event');
        } else {
          assert.strictEqual(nftAirdropDistributionEvent.data.transactionCount, 2);
          assert.strictEqual(nftTransferEvents.length, 2);
          assert.ok(nftAirdropFinishedEvent, 'expected nftAirdropFinished event');
        }
      }

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should initiate multiple airdrops and run distribution simultaneous', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.1", "maxTransactionsPerAirdrop": 10, "maxTransactionsPerAccount": 3, "maxTransactionsPerBlock": 4, "maxAirdropsPerBlock": 2, "processingBatchSize": 5}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "nftairdrops", "tickAction": "tick" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "bennierex", "quantity": "1984", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT", "symbol": "TSTNFT", "url": "http://mynft.com", "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "blue"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "orange"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "yellow"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "red"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "purple"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "green"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "white"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "grey"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "black"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "transparent"} }
      ] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "bait002", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "contract owned test NFT 2", "symbol": "TSTNFTC", "url": "http://mynft.com", "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFTC", "name":"series", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "abcdef"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "abcdef"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "abcdef"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "abcdef"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "abcdef"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "ghijkl"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "ghijkl"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "ghijkl"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "ghijkl"} },
        { "symbol": "TSTNFTC", "to":"bait002", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"series": "ghijkl"} }
      ] }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      const airdrops = {
        TSTNFT: [
          { to: "bait002", ids: ["1", "2"] },
          { to: "aggroed", ids: ["3", "4"] },
          { to: "cryptomancer", ids: ["5", "6", "7"] },
          { to: "nftmarket", toType: "contract", ids: ["8", "9", "10"] },
        ],
        TSTNFTC: [
          { to: "bennierex", ids: ["10", "9"] },
          { to: "aggroed", ids: ["8", "7"] },
          { to: "cryptomancer", ids: ["6", "5", "4"] },
          { to: "nftmarket", toType: "contract", ids: ["3", "2", "1"] },
        ],
      }

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // Airdrop directly initiated by user.
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": ${JSON.stringify(airdrops['TSTNFT'])} }`));
      // Airdrop initiated by user via other contract.
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bait002', 'testcontract', 'doAirdrop', `{ "isSignedWithActiveKey": true, "fromType": "user", "startBlockNumber": 4, "symbol": "TSTNFTC", "list": ${JSON.stringify(airdrops['TSTNFTC'])} }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      }

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      // Make sure all expected NFTs have been transferred to the contract.
      let nftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {
          _id: { $in: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          account: 'nftairdrops',
          ownedBy: 'c',
        }
      });
      assert.strictEqual(nftInstances.length, 10);
      nftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTCinstances',
        query: {
          _id: { $in: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          account: 'nftairdrops',
          ownedBy: 'c',
        }
      });
      assert.strictEqual(nftInstances.length, 10);

      // Check if airdrop has been correctly added to the database.
      let pendingAirdrops = await fixture.database.find({
        contract: 'nftairdrops',
        table: 'pendingAirdrops',
        query: {},
      });
      assert.strictEqual(pendingAirdrops.length, 2);
      assert.strictEqual(pendingAirdrops[0].symbol, 'TSTNFT');
      assert.strictEqual(pendingAirdrops[0].from, 'bennierex');
      assert.strictEqual(pendingAirdrops[0].fromType, 'user');
      assert.strictEqual(pendingAirdrops[0].nftIds.length, 10);
      assert.strictEqual(pendingAirdrops[1].symbol, 'TSTNFTC');
      assert.strictEqual(pendingAirdrops[1].from, 'bait002');
      assert.strictEqual(pendingAirdrops[1].fromType, 'user');
      assert.strictEqual(pendingAirdrops[1].nftIds.length, 10);

      const pendingAirdropsIds = pendingAirdrops.map((x) => { return x.airdropId });

      // Assert airdrop execution for the next three blocks.
      for (let i = 0; i < 6; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'whatever', 'whatever', '')); // No-op to force block creation.

        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD2',
          prevRefHiveBlockId: 'ABCD1',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        }

        await fixture.sendBlock(block);

        const blockInfo = await fixture.database.getLatestBlockInfo();
        const virtualEventLog = blockInfo.virtualTransactions.map(x => JSON.parse(x.logs).events).flat();
        const nftAirdropDistributionEvents = virtualEventLog.filter(x => x.event === 'nftAirdropDistribution');
        const nftAirdropFinishedEvents = virtualEventLog.filter(x => x.event === 'nftAirdropFinished');
        const nftTransferEvents = virtualEventLog.filter(x => x.contract ==='nft' && x.event === 'transfer');

        if (i === 0) {
          // The first airdrop should have started, distributing 4 NFT's.
          assert.strictEqual(nftTransferEvents.length, 4);
          assert.strictEqual(nftAirdropDistributionEvents.length, 1);
          assert.strictEqual(nftAirdropDistributionEvents[0].data.airdropId, pendingAirdropsIds[0]);
          assert.strictEqual(nftAirdropDistributionEvents[0].data.symbol, 'TSTNFT');
          assert.strictEqual(nftAirdropDistributionEvents[0].data.transactionCount, 4);
        }
        if (i >= 1 && i <= 3) {
          // Now both airdrops should be distributing 2 NFT's each.
          assert.strictEqual(nftTransferEvents.length, 4);
          assert.strictEqual(nftAirdropDistributionEvents.length, 2);
          assert.strictEqual(nftAirdropDistributionEvents[0].data.airdropId, pendingAirdropsIds[0]);
          assert.strictEqual(nftAirdropDistributionEvents[0].data.symbol, 'TSTNFT');
          assert.strictEqual(nftAirdropDistributionEvents[0].data.transactionCount, 2);
          assert.strictEqual(nftAirdropDistributionEvents[1].data.airdropId, pendingAirdropsIds[1]);
          assert.strictEqual(nftAirdropDistributionEvents[1].data.symbol, 'TSTNFTC');
          assert.strictEqual(nftAirdropDistributionEvents[1].data.transactionCount, 2);
        }
        if (i === 3) {
          // First airdrop should have finished in this block.
          assert.strictEqual(nftAirdropFinishedEvents.length, 1);
          assert.strictEqual(nftAirdropFinishedEvents[0].data.airdropId, pendingAirdropsIds[0]);
        }
        if (i === 4) {
          // Second airdrop should have finished as well.
          assert.strictEqual(nftAirdropDistributionEvents[0].data.airdropId, pendingAirdropsIds[1]);
          assert.strictEqual(nftAirdropDistributionEvents[0].data.symbol, 'TSTNFTC');
          assert.strictEqual(nftAirdropDistributionEvents[0].data.transactionCount, 4);
          assert.strictEqual(nftTransferEvents.length, 4);
          assert.strictEqual(nftAirdropFinishedEvents.length, 1);
          assert.strictEqual(nftAirdropFinishedEvents[0].data.airdropId, pendingAirdropsIds[1]);
        }
        if (i === 5) {
          // Expecting no airdrop activity in this block.
          assert.strictEqual(nftAirdropDistributionEvents.length, 0);
          assert.strictEqual(nftAirdropFinishedEvents.length, 0);
          assert.strictEqual(nftTransferEvents.length, 0);
        }
      }

      // Check if all NFT's are transferred to the expected accounts.
      const tstnftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {
          _id: { $in: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          account: { $in: ['bait002', 'aggroed', 'cryptomancer', 'nftmarket'] },
        },
        indexes: [{ index: '_id', descending: false }],
      });
      assert.strictEqual(tstnftInstances.length, 10);
      for (let i = 0; i < airdrops.TSTNFT.length; i += 1) {
        const { to, toType, ids } = airdrops.TSTNFT[i];
        const ownedBy = (toType === 'contract') ? 'c' : 'u';
        const nfts = tstnftInstances.filter(x => x.account === to && x.ownedBy === ownedBy && ids.includes(BigNumber(x._id).toString()));
        assert.strictEqual(ids.length, nfts.length);
      }
      const tstnftcInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTCinstances',
        query: {
          _id: { $in: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          account: { $in: ['bennierex', 'aggroed', 'cryptomancer', 'nftmarket'] },
        },
        indexes: [{ index: '_id', descending: true }],
      });
      assert.strictEqual(tstnftcInstances.length, 10);
      for (let i = 0; i < airdrops.TSTNFTC.length; i += 1) {
        const { to, toType, ids } = airdrops.TSTNFTC[i];
        const ownedBy = (toType === 'contract') ? 'c' : 'u';
        const nfts = tstnftcInstances.filter(x => x.account === to && x.ownedBy === ownedBy && ids.includes(BigNumber(x._id).toString()));
        assert.strictEqual(ids.length, nfts.length);
      }

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should initiate airdrop and fail during distribution', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.1", "maxTransactionsPerAirdrop": 50, "maxTransactionsPerAccount": 15, "maxTransactionsPerBlock": 50, "maxAirdropsPerBlock": 2, "processingBatchSize": 50}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "nftairdrops", "tickAction": "tick" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "bennierex", "quantity": "1984", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT", "symbol": "TSTNFT", "url": "http://mynft.com", "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "blue"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "orange"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "yellow"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "red"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "purple"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "green"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "white"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "grey"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "black"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "silver"} }
      ] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "lime"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "olive"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "navy"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "aqua"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "transparent"} }
      ] }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // Hard fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "softFail": false, "list": [
        { "to": "bait002", "ids": ["1", "2"] },
        { "to": "aggroed", "ids": ["3", "4", "9"] },
        { "to": "nftairdrops", "toType": "contract", "ids": ["8", "10"] },
        { "to": "cryptomancer", "ids": ["5", "6", "7"] }
      ] }`));
      // Soft fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["14"] },
        { "to": "aggroed", "ids": ["15"] },
        { "to": "nftairdrops", "toType": "contract", "ids": ["12", "13"] },
        { "to": "cryptomancer", "ids": ["11"] }
      ] }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      }

      await fixture.sendBlock(block);

      // Make sure there were no unexpected errors.
      await tableAsserts.assertNoErrorInLastBlock();

      // Make sure all expected NFTs have been transferred to the contract.
      let nftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {
          _id: { $in: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
          account: 'nftairdrops',
          ownedBy: 'c',
        }
      });
      assert.strictEqual(nftInstances.length, 15);

      for (let i = 0; i < 5; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'whatever', 'whatever', '')); // No-op to force block creation.
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD2',
          prevRefHiveBlockId: 'ABCD1',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        }
        await fixture.sendBlock(block);
      }

      // Check if all NFT's are transferred to the expected accounts.
      const expectedResult = [
        { to: "bait002", ids: ["14"] },
        { to: "aggroed", ids: ["15"] },
        { to: "cryptomancer", ids: ["5", "6", "7", "11"] },
        { to: "bennierex", ids: ["1", "2", "3", "4", "8", "9", "10", "12", "13"] }, // These should have been returned to sender.
      ];
      const tstnftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {
          _id: { $in: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
        },
        indexes: [{ index: '_id', descending: false }],
      });
      assert.strictEqual(tstnftInstances.length, 15);
      for (let i = 0; i < expectedResult.length; i += 1) {
        const { to, ids } = expectedResult[i];
        const nfts = tstnftInstances.filter(x => x.account === to && x.ownedBy === 'u' && ids.includes(BigNumber(x._id).toString()));
        assert.strictEqual(ids.length, nfts.length);
      }

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not initiate airdrop', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nftairdrops', 'updateParams', '{"feePerTransaction": "0.15", "maxTransactionsPerAirdrop": 3, "maxTransactionsPerAccount": 2, "maxTransactionsPerBlock": 4, "maxAirdropsPerBlock": 2, "processingBatchSize": 5, "enabledFromTypes": ["user", "contract"]}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "nftairdrops", "tickAction": "tick" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "nftairdrops", "quantity": "10", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "bennierex", "quantity": "1100.35", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT", "symbol": "TSTNFT", "url": "http://mynft.com", "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'addProperty', '{ "isSignedWithActiveKey": true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey": true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": [
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "blue"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "orange"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "yellow"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "red"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "purple"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "green"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "white"} },
        { "symbol": "TSTNFT", "to":"testcontract", "toType": "contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "grey"} },
        { "symbol": "TSTNFT", "to":"yabapmatt", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "black"} },
        { "symbol": "TSTNFT", "to":"bennierex", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"color": "transparent"} }
      ] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to": "cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["10"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "list": [] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "DOESNTEXIST", "list": [] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TsTnFt", "list": [] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "cryptomancer", "ids": ["3"] }, { "to": "bennierex", "ids": ["4"] }
      ] }`)); // 3
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1", "3", "5"] }, { "to": "aggroed", "ids": ["2", "4"] }, { "to": "cryptomancer", "ids": ["6", "7"] }, { "to": "bennierex", "ids": ["44"] }
      ] }`)); // 4
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "be", "ids": ["3"] }
      ] }`)); // 5
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "bennierex", "ids": "44" }
      ] }`)); // 6
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "bennierex", "ids": [] }
      ] }`)); // 7
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bennierex", "ids": ["1", "2", "3"] }
      ] }`)); // 8
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bennierex", "ids": [1, 2, 3] }
      ] }`)); // 9
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bennierex", "ids": ["a", "1.0", "zzzz"] }
      ] }`)); // 10
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["1"] }
      ] }`)); // 11
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["9"] }
      ] }`)); // 12
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["10"] }
      ] }`)); // 13
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["3"] }
      ], "startBlockNumber": "100000009" }`)); // 14
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["3"] }
      ], "startBlockNumber": 2 }`)); // 15
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'nftairdrops', 'newAirdrop', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "list": [
        { "to": "bait002", "ids": ["1"] }, { "to": "aggroed", "ids": ["2"] }, { "to": "bennierex", "ids": ["3"] }
      ] }`)); // 16
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "testcontract", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'bennierex', 'testcontract', 'doAirdrop', `{ "isSignedWithActiveKey": true, "fromType": "contract", "symbol": "TSTNFT", "list": [
        { "to": "aggroed", "ids": ["8"] }
      ] }`)); // 18

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD2',
        prevRefHiveBlockId: 'ABCD1',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      }

      await fixture.sendBlock(block);

      const blockInfo = await fixture.database.getLatestBlockInfo();
      const txs = blockInfo.transactions;

      assertError(txs[0],  'you must use a custom_json signed with your active key');
      assertError(txs[1],  'invalid symbol'); // doesn't exist
      assertError(txs[2],  'invalid symbol'); // illegal name
      assertError(txs[3],  'exceeded airdrop transactions limit'); // too many accounts
      assertError(txs[4],  'exceeded airdrop transactions limit'); // too many total nfts
      assertError(txs[5],  'invalid account be at index 2');
      assertError(txs[6],  'invalid nft ids array for account bennierex at index 1'); // not an array
      assertError(txs[7],  'invalid nft ids array for account bennierex at index 1'); // empty array
      assertError(txs[8],  'invalid nft ids array for account bennierex at index 0'); // array size > params.maxTransactionsPerAccount
      assertError(txs[9],  'invalid nft ids array for account bennierex at index 0'); // array items wrong type
      assertError(txs[10], 'invalid nft ids array for account bennierex at index 0'); // array items not valid ids
      assertError(txs[11], 'airdrop list contains duplicate nfts');
      assertError(txs[12], 'cannot airdrop nfts that are delegated or not owned by this account'); // owned by other account
      assertError(txs[13], 'cannot airdrop nfts that are delegated or not owned by this account'); // delegated
      assertError(txs[14], 'invalid startBlockNumber'); // wrong type
      assertError(txs[15], 'invalid startBlockNumber'); // lte current blocknumber
      assertError(txs[16], 'you must have enough tokens to cover the airdrop fee');
      assert.strictEqual(JSON.parse(txs[18].logs).errors[1], 'could not secure NFTs');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
