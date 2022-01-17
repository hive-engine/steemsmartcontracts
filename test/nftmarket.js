/* eslint-disable */
const assert = require('assert');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
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
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const nftmarketContractPayload = setupContractPayload('nftmarket', './contracts/nftmarket.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

// nftmarket 
describe('nftmarket', function() {
  this.timeout(20000);

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

  it('sets market parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // verify params table exists but no market specific params created yet
      let exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'params'
      });
      assert.equal(exists, true);

      let params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(params.length, 0);

      // now set some market parameters
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "mancermart" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(2);
      console.log(res.transactions[0].logs);
      params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentCut, undefined);
      assert.equal(params[0].minFee, undefined);

      // set more market parameters
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentCut": 500 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(3);
      console.log(res.transactions[0].logs);
      params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentCut, 500);
      assert.equal(params[0].minFee, undefined);

      // set yet more market parameters
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 100 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(4);
      console.log(res.transactions[0].logs);
      params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentCut, 500);
      assert.equal(params[0].minFee, 100);

      // set a combination of parameters
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 50 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "splinterlands", "agentCut": 1200 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "peakmonsters", "agentCut": 1100, "minFee": 250 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(5);
      console.log(res.transactions[0].logs);
      console.log(res.transactions[1].logs);
      console.log(res.transactions[2].logs);
      params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "peakmonsters");
      assert.equal(params[0].agentCut, 1100);
      assert.equal(params[0].minFee, 250);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not set market parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // all these should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentCut": 15000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 100.0001 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 100 }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // verify params table exists but no market specific params created
      let exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'params'
      });
      assert.equal(exists, true);

      let params = await fixture.database.find({
        contract: 'nftmarket',
        table: 'params',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(params.length, 0);

      // verify failure conditions
      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(JSON.parse(transactionsBlock1[7].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[8].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[9].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[10].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[11].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[12].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('enables a market', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      

      // check if the market tables were created
      let exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTsellBook'
      });

      
      assert.equal(exists, true);

      exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTopenInterest'
      });

      
      assert.equal(exists, true);

      exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTtradesHistory'
      });

      
      assert.equal(exists, true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not enable a market', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": false, "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "badparam": "error" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "INVALID" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must be the issuer');

      // check if the market tables were created
      let exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTsellBook'
      });

      
      assert.equal(exists, false);

      exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTopenInterest'
      });

      
      assert.equal(exists, false);

      exists = await fixture.database.tableExists({
        contract: 'nftmarket',
        table: 'TESTtradesHistory'
      });

      
      assert.equal(exists, false);

      // test that market cannot be enabled twice
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'market already enabled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('allows buyers to hit many sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        const accountNum = i - 39;
        const accountName = 'account' + accountNum.toString();
        transactions.push(new Transaction(refBlockNumber, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "properties": {"level":${i-38}, "color": "red"}, "to":"${accountName}", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // do 50 sell orders (the maximum allowed)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      for (let i = 90; i < 90+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        const accountNum = i - 90;
        const accountName = 'account' + accountNum.toString();
        transactions.push(new Transaction(refBlockNumber, txId, accountName, 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol":"TEST", "nfts": ["${i-89}"], "price": "0.1", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 100 }`));
      }

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 0);

      // check if orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      assert.equal(openInterest.length, 50);
      assert.equal(openInterest[0].count, 1);

      // now buy all the orders
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent to the buyer
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 50);

      // check if orders have been removed
      orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      
      assert.equal(orders.length, 0);

      // check that payment + fees were subtracted from buyer's account
      let balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'cryptomancer' }
      });
      
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '175.00000000');

      // check that fees were sent to market account
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'peakmonsters' }
      });
      
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.05000000');

      // check that payments were sent to sellers
      for (let i = 0; i < 50; i += 1) {
        const accountName = 'account' + i.toString();
        balances = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { account: accountName }
        });
        assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
        assert.equal(balances[0].balance, '0.09900000');
        assert.equal(balances[0].account, accountName);
      }

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 50);
      assert.equal(openInterest[0].count, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not allow buyers to hit sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"mancermart", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"yabapmatt", "quantity":"3.14158999", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "mancermart", "agentCut": 2000 }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "TKN", "fee": 500 }'));

      // all these buys should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "BUSTED", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": false, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonstersssssssssssssssssssssssssssssssssssssssssssss", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'yabapmatt', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "expPriceSymbol": "ENG", "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', `{ "isSignedWithActiveKey": true, "expPriceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expPrice": "9.42477001", "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3"] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "cryptomancer", "symbol": "TEST", "nfts": ["1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'mancermart', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "cryptomancer", "symbol": "TEST", "nfts": ["1"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(JSON.parse(transactionsBlock1[20].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[21].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[22].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[23].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[24].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[25].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[26].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[27].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[28].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[29].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[30].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[31].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[32].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid market account');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'cannot fill your own orders');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'all orders must have the same price symbol');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'you must have enough tokens for payment');
      assert.equal(JSON.parse(transactionsBlock1[28].logs).errors[0], 'cannot act on more than 50 IDs at once');
      assert.equal(JSON.parse(transactionsBlock1[29].logs).errors[0], 'unexpected price symbol BEE');
      assert.equal(JSON.parse(transactionsBlock1[30].logs).errors[0], 'total required payment 9.42477000 BEE does not match expected amount');
      assert.equal(JSON.parse(transactionsBlock1[31].logs).errors[0], 'market account cannot be same as buyer');
      assert.equal(JSON.parse(transactionsBlock1[32].logs).errors[0], 'official market account cannot be same as buyer');

      // check if the NFT instances are still owned by the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc","cryptomancer"] } }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 4);

      // check if orders still exist
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      
      assert.equal(orders.length, 4);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('allows buyers to hit sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 0 }`));

      // now buy the orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', `{ "isSignedWithActiveKey": true, "expPriceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expPrice": "25.424770", "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","2","3","4","4","5"] }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[18].logs);

      // check if the NFT instances were sent to the buyer
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc","nftmarket"] } }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 5);

      // check if orders have been removed
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      
      assert.equal(orders.length, 0);

      // check that payment + fees were subtracted from buyer's account
      let balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'cryptomancer' }
      });
      
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '168.07523000');

      // check that fees were sent to market account
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'peakmonsters' }
      });
      
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.87123850');

      // check that payments were sent to sellers
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });
      
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '8.95353150');
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '15.60000000');
      assert.equal(balances[1].account, 'marc');

      // check that trade history table was updated
      let history = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      
      assert.equal(history.length, 1);
      console.log(JSON.stringify(history[0]));

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('maintains open interest', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "properties": {"level":1, "color": "red"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "properties": {"level":1, "color": "red"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "properties": {"level":1, "color": "blue"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "properties": {"level":2, "color": "green"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "properties": {"level":1, "color": "red"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "properties": {"level":1, "color": "red"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "properties": {"level":1, "color": "red"}, "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5","6","7"], "price": "8.000", "priceSymbol": "TKN", "fee": 500 }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 4);
      assert.equal(openInterest[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[0].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[0].count, 2);
      assert.equal(openInterest[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[1].grouping), '{"level":"1","color":"blue"}');
      assert.equal(openInterest[1].count, 1);
      assert.equal(openInterest[2].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[2].grouping), '{"level":"2","color":"green"}');
      assert.equal(openInterest[2].count, 1);
      assert.equal(openInterest[3].priceSymbol, 'TKN');
      assert.equal(JSON.stringify(openInterest[3].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[3].count, 3);

      // cancel some orders
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5", "6"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["7"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 4);
      assert.equal(openInterest[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[0].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[0].count, 2);
      assert.equal(openInterest[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[1].grouping), '{"level":"1","color":"blue"}');
      assert.equal(openInterest[1].count, 1);
      assert.equal(openInterest[2].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[2].grouping), '{"level":"2","color":"green"}');
      assert.equal(openInterest[2].count, 1);
      assert.equal(openInterest[3].priceSymbol, 'TKN');
      assert.equal(JSON.stringify(openInterest[3].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[3].count, 0);

      // buy some orders
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["2","3"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      
      assert.equal(openInterest.length, 4);
      assert.equal(openInterest[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[0].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[0].count, 1);
      assert.equal(openInterest[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[1].grouping), '{"level":"1","color":"blue"}');
      assert.equal(openInterest[1].count, 0);
      assert.equal(openInterest[2].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(JSON.stringify(openInterest[2].grouping), '{"level":"2","color":"green"}');
      assert.equal(openInterest[2].count, 1);
      assert.equal(openInterest[3].priceSymbol, 'TKN');
      assert.equal(JSON.stringify(openInterest[3].grouping), '{"level":"1","color":"red"}');
      assert.equal(openInterest[3].count, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('maintains trade history', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5","6","7"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // now buy a few
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","5"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "splintermart", "agentCut": 2000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["2"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentCut": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["3"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[23].logs);

      // check that trade history table was updated
      let history = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      console.log(history[0]);
      console.log(history[1]);
      console.log(history[2]);
      assert.equal(history.length, 3);
      assert.equal(history[0].timestamp, 1527811200);
      assert.equal(history[0].volume, 2);
      assert.equal(history[0].counterparties.length, 2);
      assert.equal(history[0].counterparties[0].nftIds[0], '1');
      assert.equal(history[0].counterparties[1].nftIds[0], '5');
      assert.equal(history[0].marketAccount, 'peakmonsters');
      assert.equal(history[0].fee, '0.55707950');
      assert.equal(history[0].agentAccount, undefined);
      assert.equal(history[0].agentFee, undefined);
      assert.equal(history[1].timestamp, 1527811200);
      assert.equal(history[1].volume, 1);
      assert.equal(history[1].counterparties.length, 1);
      assert.equal(history[1].counterparties[0].nftIds[0], '2');
      assert.equal(history[1].marketAccount, 'splintermart');
      assert.equal(history[1].fee, '0.12566360');
      assert.equal(history[1].agentAccount, 'peakmonsters');
      assert.equal(history[1].agentFee, '0.03141590');
      assert.equal(history[2].timestamp, 1527811200);
      assert.equal(history[2].volume, 1);
      assert.equal(history[2].counterparties.length, 1);
      assert.equal(history[2].counterparties[0].nftIds[0], '3');
      assert.equal(history[2].marketAccount, undefined);
      assert.equal(history[2].fee, undefined);
      assert.equal(history[2].agentAccount, 'peakmonsters');
      assert.equal(history[2].agentFee, '0.15707950');

      // check that open interest was recorded
      let openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 3);

      // do another buy at a later time
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentCut": 0 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["4"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block2 = await fixture.database.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[1].logs);

      // check that trade history table was updated
      history = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      console.log(history[3]);
      assert.equal(history.length, 4);
      assert.equal(history[0].timestamp, 1527811200);
      assert.equal(history[0].volume, 2);
      assert.equal(history[0].counterparties.length, 2);
      assert.equal(history[0].counterparties[0].nftIds[0], '1');
      assert.equal(history[0].counterparties[1].nftIds[0], '5');
      assert.equal(history[1].timestamp, 1527811200);
      assert.equal(history[1].volume, 1);
      assert.equal(history[1].counterparties.length, 1);
      assert.equal(history[1].counterparties[0].nftIds[0], '2');
      assert.equal(history[2].timestamp, 1527811200);
      assert.equal(history[2].volume, 1);
      assert.equal(history[2].counterparties.length, 1);
      assert.equal(history[2].counterparties[0].nftIds[0], '3');
      assert.equal(history[3].timestamp, 1527897600);
      assert.equal(history[3].volume, 1);
      assert.equal(history[3].counterparties.length, 1);
      assert.equal(history[3].counterparties[0].nftIds[0], '4');
      assert.equal(history[3].marketAccount, 'splintermart');
      assert.equal(history[3].fee, '0.15707950');
      assert.equal(history[3].agentAccount, undefined);
      assert.equal(history[3].agentFee, undefined);

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 2);

      // check that payment + fees were subtracted from buyer's account
      let balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'cryptomancer' }
      });

      console.log(balances[0].balance);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '172.33364000');

      // check that fees were sent to official market account
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'splintermart' }
      });

      console.log(balances[0].balance);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.28274310');

      // check that fees were sent to agent account
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'peakmonsters' }
      });

      console.log(balances[0].balance);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.74557490');

      // check that payments were sent to sellers
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      console.log(balances[0].balance);
      console.log(balances[1].balance);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '11.93804200');
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '7.60000000');
      assert.equal(balances[1].account, 'marc');

      // do another buy at a later time
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["6"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:01',
        transactions,
      };

      await fixture.sendBlock(block);

      // check that trade history table was updated
      history = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      assert.equal(history.length, 2);
      assert.equal(history[0].timestamp, 1527897600);
      assert.equal(history[0].volume, 1);
      assert.equal(history[0].counterparties.length, 1);
      assert.equal(history[0].counterparties[0].nftIds[0], '4');
      assert.equal(history[1].timestamp, 1527897601);
      assert.equal(history[1].volume, 1);
      assert.equal(history[1].counterparties.length, 1);
      assert.equal(history[1].counterparties[0].nftIds[0], '6');

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 1);

      // do one more buy to advance the clock further
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["7"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:02',
        transactions,
      };

      await fixture.sendBlock(block);

      // check that trade history table was updated
      history = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      assert.equal(history.length, 1);
      assert.equal(history[0].timestamp, 1527984002);
      assert.equal(history[0].volume, 1);
      assert.equal(history[0].counterparties.length, 1);
      assert.equal(history[0].counterparties[0].nftIds[0], '7');

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('changes the price of sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // change the price on some orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","2","2","5","5"], "price": "15.666" }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      
      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      
      assert.equal(instances.length, 4);

      // check if orders have the correct price
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      
      assert.equal(orders.length, 4);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '15.66600000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);
      assert.equal(orders[1].account, 'aggroed');
      assert.equal(orders[1].ownedBy, 'u');
      assert.equal(orders[1].nftId, '2');
      assert.equal(orders[1].price, '15.66600000');
      assert.equal(orders[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[1].timestamp, 1527811200000);
      assert.equal(orders[1].fee, 500);
      assert.equal(orders[2].account, 'aggroed');
      assert.equal(orders[2].ownedBy, 'u');
      assert.equal(orders[2].nftId, '3');
      assert.equal(orders[2].price, '3.14159000');
      assert.equal(orders[2].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[2].timestamp, 1527811200000);
      assert.equal(orders[2].fee, 500);
      assert.equal(orders[3].account, 'marc');
      assert.equal(orders[3].ownedBy, 'u');
      assert.equal(orders[3].nftId, '4');
      assert.equal(orders[3].price, '8.00000000');
      assert.equal(orders[3].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[3].timestamp, 1527811200000);
      assert.equal(orders[3].fee, 500);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not change the price of sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["3"], "price": "5.123", "priceSymbol": "TKN", "fee": 500 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // try to change the price on some orders - these should all fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "nfts": ["1","2"], "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1","2"], "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"], "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1",2], "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": 15.666 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "15.6666666666666666666666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "15.666" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","4"], "price": "15.666" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'cannot act on more than 50 IDs at once');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'all orders must have the same price symbol');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'all orders must be your own');

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 4);

      // check if orders have the correct price
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      
      assert.equal(orders.length, 4);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '3.14159000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);
      assert.equal(orders[1].account, 'aggroed');
      assert.equal(orders[1].ownedBy, 'u');
      assert.equal(orders[1].nftId, '2');
      assert.equal(orders[1].price, '3.14159000');
      assert.equal(orders[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[1].timestamp, 1527811200000);
      assert.equal(orders[1].fee, 500);
      assert.equal(orders[2].account, 'aggroed');
      assert.equal(orders[2].ownedBy, 'u');
      assert.equal(orders[2].nftId, '3');
      assert.equal(orders[2].price, '5.123');
      assert.equal(orders[2].priceSymbol, 'TKN');
      assert.equal(orders[2].timestamp, 1527811200000);
      assert.equal(orders[2].fee, 500);
      assert.equal(orders[3].account, 'marc');
      assert.equal(orders[3].ownedBy, 'u');
      assert.equal(orders[3].nftId, '4');
      assert.equal(orders[3].price, '8.00000000');
      assert.equal(orders[3].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[3].timestamp, 1527811200000);
      assert.equal(orders[3].fee, 500);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not cancel sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a couple sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // try to cancel the orders - all of these should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "nfts": ["1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": {"id": "1"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","notanumber"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "nfts": ["1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot act on more than 50 IDs at once');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'all orders must be your own');

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 2);

      // verify no orders were canceled
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 2);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('cancels multiple sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(refBlockNumber, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // do 50 sell orders (the maximum allowed)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      // check if orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);

      // now cancel all the orders
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent back to the owner
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 50);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      // check if orders were removed
      orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('cancels a sell order', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a couple sell orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 2);

      // check if orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 2);

      // check that open interest was recorded
      let openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 2);

      // cancel an order
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5", "500", "1"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      

      // check if the NFT instances were sent back to the user who placed the order
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 1);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 1);

      // check if orders were removed
      orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 1);
      

      // check that open interest was recorded
      openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a sell order', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"isRare", "type":"boolean" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","isRare"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TEST", "nfts": [{"id":"1", "properties": {"level":3, "color":"red", "isRare": true}}] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 400 }'));

      // do a sell order
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","1","2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      
      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      
      assert.equal(instances.length, 1);

      // check if orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      
      assert.equal(orders.length, 1);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(JSON.stringify(orders[0].grouping), '{"level":"3","isRare":"true"}');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '2.00000000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);

      // check that open interest was recorded
      let openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not create a sell order', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));

      // all sell orders below here should fail      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFee": 250 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.123456789123456789", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 200 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.123456789123456789", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "notanumber", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 10001 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "INVALID", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "NOEXIST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["notanumber"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(JSON.parse(transactionsBlock1[7].logs).errors[0]);
      console.log(transactionsBlock1[8].logs);
      console.log(transactionsBlock1[9].logs);
      console.log(JSON.parse(transactionsBlock1[10].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[11].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[12].logs).errors[0]);
      console.log(transactionsBlock1[13].logs);
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(JSON.parse(transactionsBlock1[16].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[17].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[18].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[19].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[20].logs).errors[0]);
      console.log(transactionsBlock1[21].logs);
      console.log(JSON.parse(transactionsBlock1[22].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[23].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[24].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'cannot sell more than 50 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'market grouping not set');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'fee must be >= 250');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid nft list');

      // make sure no tokens were sent to the market
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      // verify no orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates multiple sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // setup environment
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(refBlockNumber, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      for (let i = 89; i < 89+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(refBlockNumber, txId, 'cryptomancer', 'nft', 'setProperties', `{ "symbol":"TEST", "nfts": [{"id":"${i-88}", "properties": {"level":${i-88}}}] }`));
      }
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      
      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // do 50 sell orders (the maximum allowed)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were sent to the market
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      // check if orders were created
      let orders = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);
      for (let j = 0; j < 50; j += 1) {
        const nftId = j + 1;
        assert.equal(orders[j].account, 'aggroed');
        assert.equal(orders[j].ownedBy, 'u');
        assert.equal(JSON.stringify(orders[j].grouping), `{"level":"${nftId}","color":""}`);
        assert.equal(orders[j].nftId, nftId.toString());
        assert.equal(orders[j].price, '2.00000000');
        assert.equal(orders[j].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
        assert.equal(orders[j].timestamp, 1527811200000);
        assert.equal(orders[j].fee, 500);
      }

      // check that open interest was recorded
      let openInterest = await fixture.database.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      
      assert.equal(openInterest.length, 50);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
