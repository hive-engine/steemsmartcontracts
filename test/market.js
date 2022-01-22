/* eslint-disable */
const assert = require('assert');
const { MongoClient, Decimal128 } = require('mongodb');

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
const mktContractPayload = setupContractPayload('market', './contracts/market.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

// Market
describe('Market', function() {
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

  it('market sells to multiple buyers', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "523.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "vitalik", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "aggroed", "quantity": "456.789", "isSignedWithActiveKey": true }'));

      // setup buy order book with several orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'market', 'buy', '{ "account": "vitalik", "symbol": "TKN", "quantity": "10", "price": "0.734" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'market', 'buy', '{ "account": "vitalik", "symbol": "TKN", "quantity": "20", "price": "0.634", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "30", "price": "0.534", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1241', 'aggroed', 'market', 'buy', '{ "symbol": "TKN", "quantity": "40", "price": "0.434", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1242', 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "50", "price": "0.334", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1243', 'aggroed', 'market', 'buy', '{ "symbol": "TKN", "quantity": "60", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check market contract has correct token amounts
      let balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].balance, 84.14);

      // test 1 - sell to half the order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'market', 'marketSell', '{ "account": "satoshi", "symbol": "TKN", "quantity": "80.001", "isSignedWithActiveKey": false }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'SWAP.HIVE', balance: '412.70900000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '44.72043400'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '416.72900000'});
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'TKN', balance: '40.001'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '443.455'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '40.000'});

      let buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: { $in: ['vitalik', 'aggroed'] },
          symbol: 'TKN'
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(buyOrders);
      assert.equal(buyOrders.length, 3);

      assert.equal(buyOrders[0].txId, 'TXID1241');
      assert.equal(buyOrders[0].account, 'aggroed');
      assert.equal(buyOrders[0].symbol, 'TKN');
      assert.equal(buyOrders[0].quantity, 19.999);

      assert.equal(buyOrders[1].txId, 'TXID1242');
      assert.equal(buyOrders[1].account, 'vitalik');
      assert.equal(buyOrders[1].symbol, 'TKN');
      assert.equal(buyOrders[1].quantity, 50);

      assert.equal(buyOrders[2].txId, 'TXID1243');
      assert.equal(buyOrders[2].account, 'aggroed');
      assert.equal(buyOrders[2].symbol, 'TKN');
      assert.equal(buyOrders[2].quantity, 60);

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].balance, 39.419566);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 0);

      // test 2 - sell to wipe out the entire order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketSell', '{ "symbol": "TKN", "quantity": "150", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check user balances are correct
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'SWAP.HIVE', balance: '412.70900000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '84.14000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '416.72900000'});
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'TKN', balance: '120.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '313.456'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '90.000'});

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].balance, 0);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 0);

      // check buy orders are gone
      buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: { $in: ['vitalik', 'aggroed'] },
          symbol: 'TKN'
        },
        indexes: [{index: '_id', descending: false}],
      });

      assert.equal(buyOrders.length, 0);

      // check volume metric looks OK
      const metric = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      console.log(metric);

      assert.equal(metric.symbol, 'TKN');
      assert.equal(metric.volume, 84.14);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('market buys from multiple sellers', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "523.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "aggroed", "quantity": "200", "isSignedWithActiveKey": true }'));

      // setup sell order book with several orders
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'market', 'sell', '{ "account": "vitalik", "symbol": "TKN", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'market', 'sell', '{ "account": "vitalik", "symbol": "TKN", "quantity": "20", "price": "0.334", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "30", "price": "0.434", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1241', 'aggroed', 'market', 'sell', '{ "symbol": "TKN", "quantity": "40", "price": "0.534", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1242', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "50", "price": "0.634", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1243', 'aggroed', 'market', 'sell', '{ "symbol": "TKN", "quantity": "60", "price": "0.734", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check market contract has correct token amounts
      let balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 210);

      // test 1 - buy up half the order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketBuy', '{ "account": "aggroed", "symbol": "TKN", "quantity": "32.040", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'SWAP.HIVE', balance: '16.68000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '424.74900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '15.36000000'});
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'TKN', balance: '80.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '78.726'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '433.456'});

      let sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: { $in: ['vitalik', 'aggroed'] },
          symbol: 'TKN'
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(sellOrders);
      assert.equal(sellOrders.length, 3);

      assert.equal(sellOrders[0].txId, 'TXID1241');
      assert.equal(sellOrders[0].account, 'aggroed');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].quantity, 21.274);

      assert.equal(sellOrders[1].txId, 'TXID1242');
      assert.equal(sellOrders[1].account, 'vitalik');
      assert.equal(sellOrders[1].symbol, 'TKN');
      assert.equal(sellOrders[1].quantity, 50);

      assert.equal(sellOrders[2].txId, 'TXID1243');
      assert.equal(sellOrders[2].account, 'aggroed');
      assert.equal(sellOrders[2].symbol, 'TKN');
      assert.equal(sellOrders[2].quantity, 60);

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 131.274);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'SWAP.HIVE');
      assert.equal(balances[1].balance, 0);

      // test 2 - buy up the entire order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'market', 'marketBuy', '{ "account": "satoshi", "symbol": "TKN", "quantity": "100" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check user balances are correct
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'SWAP.HIVE', balance: '72.08031600'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '337.64868400'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '47.06000000'});
      await tableAsserts.assertUserBalances({ account: 'aggroed', symbol: 'TKN', balance: '80.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '210.000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '433.456'});

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 0);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'SWAP.HIVE');
      assert.equal(balances[1].balance, 0);

      // check sell orders are gone
      sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: { $in: ['vitalik', 'aggroed'] },
          symbol: 'TKN'
        },
        indexes: [{index: '_id', descending: false}],
      });

      assert.equal(sellOrders.length, 0);

      // check volume metric looks OK
      const metric = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      console.log(metric);

      assert.equal(metric.symbol, 'TKN');
      assert.equal(metric.volume, 119.140316);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not market buy dust amounts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));

      // try to buy too small amount
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketBuy', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '456.78900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '23.456'});

      let sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN'
        }
      });

      assert.equal(sellOrders.length, 1);

      console.log(sellOrders);

      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].quantity, 100);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('market buys from one seller', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));

      // test 1 - completely fill sell order
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketBuy', '{ "symbol": "TKN", "quantity": "23.4", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '433.38900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '23.4'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '100.000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '23.456'});

      let sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN'
        }
      });

      assert.equal(sellOrders.length, 0);

      // test 2 - try to market buy an empty order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketBuy', '{ "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '433.38900000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '100.000'});

      // test 3 - partially fill sell order
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "23", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'marketBuy', '{ "symbol": "TKN", "quantity": "4", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check user balances are correct
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '429.38900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '27.40000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '117.094'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '0.456'});

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 5.906);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'SWAP.HIVE');
      assert.equal(balances[1].balance, 0);

      // check sell order was updated
      sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN'
        }
      });

      console.log(sellOrders);
      assert.equal(sellOrders.length, 1);

      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].quantity, 5.906);

      // check volume metric looks OK
      const metric = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      console.log(metric);

      assert.equal(metric.symbol, 'TKN');
      assert.equal(metric.volume, 27.4);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('market sells to one buyer', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));

      // test 1 - completely fill buy order
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "50", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'marketSell', '{ "symbol": "TKN", "quantity": "100.789", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '445.08900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '11.70000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '73.456'});

      let buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN'
        }
      });

      assert.equal(buyOrders.length, 0);

      // test 2 - try to market sell to an empty order book
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'vitalik', 'market', 'marketSell', '{ "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));

       block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '11.70000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '73.456'});

      // test 3 - partially fill buy order
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "40", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'marketSell', '{ "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check user balances are correct
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '14.04000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '435.72900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN', balance: '63.456'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '60.000'});

      // check market contract has correct token amounts
      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: { $in: ['TKN', 'SWAP.HIVE'] },
          account: { $in: ['market'] }
        }
      });

      console.log(balances);

      assert.equal(balances[0].account, 'market');
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].balance, 7.02);

      assert.equal(balances[1].account, 'market');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 0);

      // check buy order was updated
      buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN'
        }
      });

      console.log(buyOrders);
      assert.equal(buyOrders.length, 1);

      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN');
      assert.equal(buyOrders[0].quantity, 30);

      // check volume metric looks OK
      const metric = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      console.log(metric);

      assert.equal(metric.symbol, 'TKN');
      assert.equal(metric.volume, 14.04);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a buy order', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "876.988", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '123.45599123'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, '0.00000877');
      assert.equal(balances[0].account, 'market');

      const sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 876.988);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates buy orders with expirations', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "expiration": 2592000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1236', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "0.00000001", "expiration": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1237', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "0.00000001", "expiration": 30000000, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1235');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, '0.00000001');
      assert.equal(buyOrders[0].quantity, 1);
      assert.equal(buyOrders[0].timestamp, 1527811200);
      assert.equal(buyOrders[0].expiration, 1527811200 + 2592000);

      assert.equal(buyOrders[1].txId, 'TXID1236');
      assert.equal(buyOrders[1].account, 'satoshi');
      assert.equal(buyOrders[1].symbol, 'TKN.TEST');
      assert.equal(buyOrders[1].price, '0.00000001');
      assert.equal(buyOrders[1].quantity, 2);
      assert.equal(buyOrders[1].timestamp, 1527811200);
      assert.equal(buyOrders[1].expiration, 1527811200 + 10);

      assert.equal(buyOrders[2].txId, 'TXID1237');
      assert.equal(buyOrders[2].account, 'satoshi');
      assert.equal(buyOrders[2].symbol, 'TKN.TEST');
      assert.equal(buyOrders[2].price, '0.00000001');
      assert.equal(buyOrders[2].quantity, 3);
      assert.equal(buyOrders[2].timestamp, 1527811200);
      assert.equal(buyOrders[2].expiration, 1527811200 + 2592000);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('generates error when trying to create a buy order with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "0.1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

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
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'order cannot be placed as it cannot be filled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates sell orders with expirations', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "expiration": 2592000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1236', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "0.00000001", "expiration": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1237', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "0.00000001", "expiration": 30000000, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 1);
      assert.equal(sellOrders[0].timestamp, 1527811200);
      assert.equal(sellOrders[0].expiration, 1527811200 + 2592000);

      assert.equal(sellOrders[1].txId, 'TXID1236');
      assert.equal(sellOrders[1].account, 'satoshi');
      assert.equal(sellOrders[1].symbol, 'TKN.TEST');
      assert.equal(sellOrders[1].price, '0.00000001');
      assert.equal(sellOrders[1].quantity, 2);
      assert.equal(sellOrders[1].timestamp, 1527811200);
      assert.equal(sellOrders[1].expiration, 1527811200 + 10);

      assert.equal(sellOrders[2].txId, 'TXID1237');
      assert.equal(sellOrders[2].account, 'satoshi');
      assert.equal(sellOrders[2].symbol, 'TKN.TEST');
      assert.equal(sellOrders[2].price, '0.00000001');
      assert.equal(sellOrders[2].quantity, 3);
      assert.equal(sellOrders[2].timestamp, 1527811200);
      assert.equal(sellOrders[2].expiration, 1527811200 + 2592000);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "100.276", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "NKT", "precision": 8, "maxSupply": "9007199254740991", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "NKT", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "NKT", "quantity": "1", "price": "9999999.99999999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "NKT", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "NKT", "quantity": "1", "price": "1", "isSignedWithActiveKey": true }'));
      
      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '23.180'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(balances[0].balance, 100.276);
      assert.equal(balances[0].account, 'market');

      const sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 100.276);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('generates error when trying to create a sell order with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "0.001", "price": "0.00000001", "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'order cannot be placed as it cannot be filled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('cancels a buy order', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1000", "price": "0.001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '122.45600000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, 1);
      assert.equal(balances[0].account, 'market');

      const buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1235');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, 0.001);
      assert.equal(buyOrders[0].quantity, 1000);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'market', 'cancel', '{ "account": "satoshi", "id": "TXID1235", "type": "buy", "isSignedWithActiveKey": false }'));

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

      console.log(transactionsBlock2[0].logs);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '123.45600000'});

      res = await fixture.database.findOne({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(res, null);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '23.456'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'TKN.TEST',
          account: 'market'
        }
      });

      assert.equal(balances[0].balance, 100);
      assert.equal(balances[0].account, 'market');

      const sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 100);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'cancel', '{ "account": "aggroed", "id": "TXID1235", "type": "sell", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '123.456'});

      res = await fixture.database.findOne({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(res, null);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('buys from the market from one seller', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1237', 'null', 'market', 'sell', '{ "account": "vitalik", "symbol": "TKN.TEST", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '2.34000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '454.44900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '23.456'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '10.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(balances[0].balance, 90);
      assert.equal(balances[0].symbol, 'TKN.TEST');
      assert.equal(balances[0].account, 'market');

      const sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 90);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('buys from the market from several sellers', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '2.00000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '6.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'SWAP.HIVE', balance: '15.00000000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'SWAP.HIVE', balance: '477.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '198.000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '97.000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'TKN.TEST', balance: '295.000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'TKN.TEST', balance: '10.000'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('buys from the market partially', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "15", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '2.00000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '6.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'SWAP.HIVE', balance: '15.00000000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'SWAP.HIVE', balance: '455.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '198.000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '97.000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'TKN.TEST', balance: '295.000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'TKN.TEST', balance: '10.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, 22);
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].account, 'market');

      const buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'harpagon',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1243');
      assert.equal(buyOrders[0].account, 'harpagon');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, 3);
      assert.equal(buyOrders[0].quantity, 5);
      assert.equal(buyOrders[0].tokensLocked, 22);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sells on the market to one buyer', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '2.34000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '433.38900000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '113.456'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '10.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, 21.06);
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].account, 'market');

      const buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 90);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sells on the market to several buyers', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '88.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '194.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'SWAP.HIVE', balance: '285.00000000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'SWAP.HIVE', balance: '33.00000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '3.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '2.000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'TKN.TEST', balance: '5.000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'TKN.TEST', balance: '490.000'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('fills a buy order from different sellers', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '9.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '6.00000000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'SWAP.HIVE', balance: '15.00000000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'SWAP.HIVE', balance: '470.00000000'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '97.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '198.000'});
      await tableAsserts.assertUserBalances({ account: 'dan', symbol: 'TKN.TEST', balance: '295.000'});
      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'TKN.TEST', balance: '10.000'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a trade history', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let trades = await fixture.database.find({
        contract: 'market',
        table: 'tradesHistory',
        query: {

        }
      });

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN.TEST');
      assert.equal(trades[0].quantity, 2);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527811200);
      assert.equal(trades[0].buyTxId, 'TXID1243');
      assert.equal(trades[0].sellTxId, 'TXID1240');

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'TKN.TEST');
      assert.equal(trades[1].quantity, 3);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527811200);
      assert.equal(trades[1].buyTxId, 'TXID1243');
      assert.equal(trades[1].sellTxId, 'TXID1241');

      assert.equal(trades[2].type, 'sell');
      assert.equal(trades[2].symbol, 'TKN.TEST');
      assert.equal(trades[2].quantity, 5);
      assert.equal(trades[2].price, 3);
      assert.equal(trades[2].timestamp, 1527811200);
      assert.equal(trades[2].buyTxId, 'TXID1243');
      assert.equal(trades[2].sellTxId, 'TXID1242');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "BTC.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12405', 'satoshi', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12416', 'vitalik', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12427', 'dan', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12438', 'harpagon', 'market', 'buy', '{ "symbol": "BTC.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      trades = await fixture.database.find({
        contract: 'market',
        table: 'tradesHistory',
        query: {

        }
      });

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN.TEST');
      assert.equal(trades[0].quantity, 2);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527811200);
      assert.equal(trades[0].buyTxId, 'TXID1243');
      assert.equal(trades[0].sellTxId, 'TXID1240');

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'TKN.TEST');
      assert.equal(trades[1].quantity, 3);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527811200);
      assert.equal(trades[1].buyTxId, 'TXID1243');
      assert.equal(trades[1].sellTxId, 'TXID1241');

      assert.equal(trades[2].type, 'sell');
      assert.equal(trades[2].symbol, 'TKN.TEST');
      assert.equal(trades[2].quantity, 5);
      assert.equal(trades[2].price, 3);
      assert.equal(trades[2].timestamp, 1527811200);
      assert.equal(trades[2].buyTxId, 'TXID1243');
      assert.equal(trades[2].sellTxId, 'TXID1242');

      assert.equal(trades[3].type, 'buy');
      assert.equal(trades[3].symbol, 'BTC.TEST');
      assert.equal(trades[3].quantity, 2);
      assert.equal(trades[3].price, 1);
      assert.equal(trades[3].timestamp, 1527814800);
      assert.equal(trades[3].buyTxId, 'TXID12438');
      assert.equal(trades[3].sellTxId, 'TXID12405');

      assert.equal(trades[4].type, 'buy');
      assert.equal(trades[4].symbol, 'BTC.TEST');
      assert.equal(trades[4].quantity, 3);
      assert.equal(trades[4].price, 2);
      assert.equal(trades[4].timestamp, 1527814800);
      assert.equal(trades[4].buyTxId, 'TXID12438');
      assert.equal(trades[4].sellTxId, 'TXID12416');

      assert.equal(trades[5].type, 'buy');
      assert.equal(trades[5].symbol, 'BTC.TEST');
      assert.equal(trades[5].quantity, 5);
      assert.equal(trades[5].price, 3);
      assert.equal(trades[5].timestamp, 1527814800);
      assert.equal(trades[5].buyTxId, 'TXID12438');
      assert.equal(trades[5].sellTxId, 'TXID12427');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, 'TXID12432', 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12413', 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12433', 'harpagon', 'market', 'buy', '{ "symbol": "BTC.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID12426', 'dan', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      trades = await fixture.database.find({
        contract: 'market',
        table: 'tradesHistory',
        query: {

        }
      });

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN.TEST');
      assert.equal(trades[0].quantity, 3);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527987600);
      assert.equal(trades[0].buyTxId, 'TXID12432');
      assert.equal(trades[0].sellTxId, 'TXID12413');

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'BTC.TEST');
      assert.equal(trades[1].quantity, 5);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527987600);
      assert.equal(trades[1].buyTxId, 'TXID12433');
      assert.equal(trades[1].sellTxId, 'TXID12426');

      assert.equal(trades.length, 2);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('maintains the different metrics', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let volume = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(volume.symbol, 'TKN.TEST');
      assert.equal(volume.volume, 30);
      let blockDate = new Date('2018-06-02T02:00:00.000Z')
      assert.equal(volume.volumeExpiration, blockDate.getTime() / 1000);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "BTC.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "BTC.TEST", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "BTC.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));


      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let metrics = await fixture.database.find({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      assert.equal(metrics[0].symbol, 'TKN.TEST');
      assert.equal(metrics[0].volume, 60);
      blockDate = new Date('2018-06-03T01:00:00.000Z');
      assert.equal(metrics[0].volumeExpiration, blockDate.getTime() / 1000);

      assert.equal(metrics[1].symbol, 'BTC.TEST');
      assert.equal(metrics[1].volume, 23);
      blockDate = new Date('2018-06-03T01:00:00.000Z');
      assert.equal(metrics[1].volumeExpiration, blockDate.getTime() / 1000);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "BTC.TEST", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dan', 'market', 'sell', '{ "symbol": "BTC.TEST", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T01:01:00',
        transactions,
      };

      await fixture.sendBlock(block);

      metrics = await fixture.database.find({
        contract: 'market',
        table: 'metrics',
        query: {

        }
      });

      assert.equal(metrics[0].symbol, 'TKN.TEST');
      assert.equal(metrics[0].volume, 9);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metrics[0].volumeExpiration, blockDate.getTime() / 1000);

      assert.equal(metrics[1].symbol, 'BTC.TEST');
      assert.equal(metrics[1].volume, 15);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metrics[1].volumeExpiration, blockDate.getTime() / 1000);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "harpagon", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "4", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-04T01:02:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const metric = await fixture.database.findOne({
        contract: 'market',
        table: 'metrics',
        query: {
        }
      });

      assert.equal(metric.symbol, 'TKN.TEST');
      assert.equal(metric.volume, 9);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metric.volumeExpiration, blockDate.getTime() / 1000);
      assert.equal(metric.lastPrice, 3);
      assert.equal(metric.highestBid, 3);
      assert.equal(metric.lowestAsk, 4);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes an expired sell order', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 10);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders.length, 0);

      let buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 100);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes an expired buy order', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN.TEST');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 100);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders.length, 0);

      sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN.TEST');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 10);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes dust sell orders', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "101", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "110", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '109.99999999'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '0.00000001'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '1.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'TKN.TEST');
      assert.equal(balances[0].account, 'market');

      let sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders.length, 0);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '0.00000002'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '109.99999998'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '99.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '2.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'TKN.TEST');
      assert.equal(balances[0].account, 'market');

      sellOrders = await fixture.database.find({
        contract: 'market',
        table: 'sellBook',
        query: {
          account: 'vitalik',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(sellOrders.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes dust buy orders', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(pegContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN.TEST", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN.TEST", "to": "vitalik", "quantity": "101", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "SWAP.HIVE", "to": "satoshi", "quantity": "110", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '0.00000001'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '109.99999999'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '100.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '1.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].account, 'market');

      let buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders.length, 0);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'vitalik', 'market', 'sell', '{ "symbol": "TKN.TEST", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'market', 'buy', '{ "symbol": "TKN.TEST", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'SWAP.HIVE', balance: '0.00000002'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'SWAP.HIVE', balance: '109.99999998'});
      await tableAsserts.assertUserBalances({ account: 'vitalik', symbol: 'TKN.TEST', balance: '99.000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN.TEST', balance: '2.000'});

      balances = await fixture.database.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'SWAP.HIVE'
        }
      });

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'SWAP.HIVE');
      assert.equal(balances[0].account, 'market');

      buyOrders = await fixture.database.find({
        contract: 'market',
        table: 'buyBook',
        query: {
          account: 'satoshi',
          symbol: 'TKN.TEST'
        }
      });

      assert.equal(buyOrders.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
