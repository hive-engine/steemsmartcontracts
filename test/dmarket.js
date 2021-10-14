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

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

const tknContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const dmarketContractPayload = setupContractPayload('dmarket', './contracts/dmarket.js');

async function assertBalances(accounts, balances, symbol, contract = false) {
  const res = await fixture.database.find({
    contract: 'tokens',
    table: contract ? 'contractsBalances' : 'balances',
    query: {
      account: {
        $in: accounts,
      },
      symbol,
    },
  });

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    const expectedBalance = balances[i];
    let balance = '0';

    try {
      // eslint-disable-next-line
      balance = (res.find(el => el.account === account)).balance;
    } catch (e) {
      assert(BigNumber(expectedBalance).isEqualTo(0), `no balance for @${account} found`);
    }

    // console.log(expectedBalance, balance, account);
    const isEqual = BigNumber(expectedBalance).eq(balance);
    assert(isEqual, `expected @${account} balance ${expectedBalance} instead got ${balance}`);
  }
}

async function verifyOpenOrders(table, account, symbol, quoteToken, num) {
  const book = await fixture.database.find({
    contract: 'dmarket',
    table,
    query: {
      account,
      symbol,
      quoteToken
    }
  });

  assert.equal(book.length, num);
}

async function verifyAskBid(symbol, quoteToken, ask, bid) {
  const res = await fixture.database.findOne({
    contract: 'dmarket',
    table: 'metrics',
    query: {
      symbol,
      quoteToken,
    },
  });

  assert(res, 'metric not found');
  assert(BigNumber(res.lowestAsk).isEqualTo(ask), `ask ${ask} not equal to ${res.lowestAsk}`);
  assert(BigNumber(res.highestBid).isEqualTo(bid), `bid ${bid} not equal to ${res.highestBid}`);
}

async function assertPair(quoteToken, symbols) {
  const res = await fixture.database.findOne({
    contract: 'dmarket',
    table: 'quoteTokens',
    query: {
      quoteToken,
    },
  });

  console.log(res);

  assert(res, 'quoteToken not found');

  if (symbols !== true) {
    assert(res.isGlobal !== true, 'quoteToken is global');
    symbols.forEach((symbol) => {
      assert(res.allowedBaseTokens.includes(symbol), `symbol ${symbol} not found in this pair`);
    });
  } else assert(res.isGlobal === true, 'quoteToken is not global');
}

describe('dMarket Smart Contract', function () {
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

  it('does not create a new pair', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": false, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": 5, "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "BEE", "baseToken": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[2], 'you must use a custom_json signed with your active key');
      assertError(txs[3], 'invalid quoteToken');
      assertError(txs[4], 'invalid baseToken');
      assertError(txs[5], 'quoteToken and baseToken can not be the same');
      assertError(txs[6], 'baseToken does not exist');
      assertError(txs[7], 'quoteToken does not exist');
      assertError(txs[10], 'you must have enough tokens to cover the pair creation fee');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a new pair', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertPair('TKN', ['BEE']);

      await assertBalances(['ali-h'], ['0'], 'BEE');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not add baseToken into existing quoteToken', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'dmarket', 'setGlobalQuoteToken', '{ "quoteToken": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "XYZ" }'));


      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await assertPair('TKN', true);

      assertError(txs[6], 'baseToken is already in this pair');
      assertError(txs[8], 'can not add another baseToken to a global quoteToken');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('adds baseToken into existing quoteToken', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "XYZ" }'));

      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertPair('TKN', ['BEE', 'XYZ']);

      await assertBalances(['ali-h'], ['0'], 'BEE');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a buy order for user added pair', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "123.456" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.1" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const result = await fixture.database.findOne({
        contract: 'dmarket',
        table: 'buyBook',
        query: {
          symbol: 'BEE',
          quoteToken: 'TKN',
          txId: txs[0].txId,
        },
      });

      console.log(result);
      // confirm some things in the order
      assert(BigNumber(result.quantity).eq(100));
      assert(BigNumber(result.price).eq(0.1));
      assert(BigNumber(result.tokensLocked).eq(10));

      await assertBalances(['ali-h'], ['113.456'], 'TKN');
      await assertBalances(['dmarket'], ['10'], 'TKN', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not create a buy order if pair does not exist', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "123.456" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.1" }'));


      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[5], 'pair does not exist');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a sell order for user added pair', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      const result = await fixture.database.findOne({
        contract: 'dmarket',
        table: 'sellBook',
        query: {
          symbol: 'BEE',
          quoteToken: 'TKN',
          txId: txs[0].txId,
        },
      });

      console.log(result);
      // confirm some things in the order
      assert(BigNumber(result.quantity).eq(100));
      assert(BigNumber(result.price).eq(0.16));

      await assertBalances(['ali-h'], ['0'], 'BEE');
      await assertBalances(['dmarket'], ['100'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not create a sell order if pair does not exist', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const refBlockNumber = fixture.getNextRefBlockNumber();
      const transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));


      const block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[4], 'pair does not exist');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('buys from one seller', (done) => {
    new Promise(async (resolve) => {
 
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "18.17" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['0', '100'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['16', '2.17'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('buys from multiple sellers', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"nomi", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"punkman", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'punkman', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'nomi', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.17" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "24.3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "135", "price": "0.18" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0', '0', '50', '135'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['16', '1.7', '4.5', '2.1'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['25'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sells to one buyer', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "55" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['0', '100'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['17', '38'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sells to multiple buyers', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "punkman", "quantity": "18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "nomi", "quantity": "18" }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'punkman', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'nomi', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.17" }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"james", "quantity":"140", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "140", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['40', '50', '50', '0'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['2', '9.5', '9', '23.9'], 'TKN');
      await assertBalances(['dmarket'], ['9.6'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('market buy from multiple sellers', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"nomi", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"punkman", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'punkman', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'nomi', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.17" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "22.2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "22.2" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0', '0', '50', '135'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['16', '1.7', '4.5', '0'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['25'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('market sell to multiple buyers', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "punkman", "quantity": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "50" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "nomi", "quantity": "12" }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'punkman', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "55", "price": "0.18" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "312", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'nomi', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.17" }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"james", "quantity":"210", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "210" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['105', '50', '55', '0'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0.08', '3.5', '0.1', '35.2'], 'TKN');
      await assertBalances(['dmarket'], ['33.12'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "16" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "99.99999999", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await verifyOpenOrders('sellBook', 'ali-h', 'BEE', 'TKN', 0);

      await assertBalances(['ali-h', 'james'], ['0.00000001', '99.99999999'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['15.999', '0.001'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "16" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100.00000001", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await verifyOpenOrders('buyBook', 'james', 'BEE', 'TKN', 0);

      await assertBalances(['ali-h', 'james'], ['0', '100'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['16', '0'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes expired buy orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "55" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "20", "price": "0.19", "expiration": 100 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "20", "price": "0.18" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // should hit the 0.18 order and expire 0.19 one
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:10:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['90', '10'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['1.8', '51.4'], 'TKN');
      await assertBalances(['dmarket'], ['1.8'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // should hit the 0.18 order and expire 0.19 one
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-04-12T00:00:06',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['90', '10'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['1.8', '53.2'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes expired sell orders', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "55" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18", "expiration": 100 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.19" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // should hit the 0.18 order and expire 0.19 one
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "4.75" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:10:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['50', '25'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['4.75', '50.25'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['25'], 'BEE', true);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // should hit the 0.18 order and expire 0.19 one
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'james', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "4.75" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-04-12T00:00:06',
        transactions,
      };

      await fixture.sendBlock(block);

      // const res = await fixture.database.getLatestBlockInfo();
      // const txs = res.transactions;

      await tableAsserts.assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['75', '25'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['4.75', '50.25'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('verify metrics', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a001", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a002", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a003", "quantity":"100", "isSignedWithActiveKey":true }`));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b001", "quantity": "100" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b002", "quantity": "100" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b003", "quantity": "100" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = fixture.getNextRefBlockNumber();
      // bid
      transactions = [];

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'b001', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.15" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'b002', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.20" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'b003', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0', '0.20');

      refBlockNumber = fixture.getNextRefBlockNumber();
      // ask
      transactions = [];

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'a001', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.23" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'a003', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.21" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'a002', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.25" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0.21', '0.20');

      refBlockNumber = fixture.getNextRefBlockNumber();
      // update after order filling
      transactions = [];

      // sell to the highest bid
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'a001', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "20" }'));

      // buy from the lowest ask
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'b001', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "4.4" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0.25', '0.15');

      const metric = await fixture.database.findOne({
        contract: 'dmarket',
        table: 'metrics',
        query: {
          symbol: 'BEE',
          quoteToken: 'TKN',
        },
      });

      console.log(metric);

      assert(BigNumber(metric.volume).eq('8.000'), 'invalid volume');
      assert(BigNumber(metric.lastPrice).eq('0.23'), 'invalid lastPrice');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
