
/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

const { fork } = require('child_process');
const assert = require('assert');
const { MongoClient } = require('mongodb');

const { default: BigNumber } = require('bignumber.js');
const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');

const conf = {
  chainId: 'test-chain-id',
  genesisHiveBlock: 2000000,
  dataDirectory: './test/data/',
  databaseFileName: 'database.db',
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: 'mongodb://localhost:27017',
  databaseName: 'testssc',
  streamNodes: ['https://api.hive.blog'],
};

const plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null;

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
};

const tknContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const dmarketContractPayload = setupContractPayload('dmarket', './contracts/dmarket.js');

let txId = 1;
function getNextTxId() {
  txId += 1;
  return `TXID${txId.toString().padStart(8, '0')}`;
}

async function assertBalances(accounts, balances, symbol, contract = false) {
  const res = await database1.find({
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

async function verifyAskBid(symbol, quoteToken, ask, bid) {
  const res = await database1.findOne({
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
  const res = await database1.findOne({
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

function assertError(tx, message) {
  const logs = JSON.parse(tx.logs);
  assert(logs.errors, `No error in logs. Error expected with message ${message}`);
  assert.equal(logs.errors[0], message, `Error expected with message ${message}. Instead got ${logs.errors[0]}`);
}

async function assertNoErrorInLastBlock() {
  const { transactions } = await database1.getLatestBlockInfo();
  for (let i = 0; i < transactions.length; i += 1) {
    const logs = JSON.parse(transactions[i].logs);
    assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
  }
}

describe('dMarket Smart Contract', function () {
  this.timeout(20000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL,
        { useNewUrlParser: true, useUnifiedTopology: true });
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
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": false, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": 5, "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": 5 }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "BEE", "baseToken": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
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
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates a new pair', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertPair('TKN', ['BEE']);

      await assertBalances(['ali-h'], ['0'], 'BEE');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not add baseToken into existing quoteToken', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'dmarket', 'setGlobalQuoteToken', '{ "quoteToken": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "XYZ" }'));


      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertPair('TKN', true);

      assertError(txs[6], 'baseToken is already in this pair');
      assertError(txs[8], 'can not add another baseToken to a global quoteToken');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds baseToken into existing quoteToken', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "XYZ" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertPair('TKN', ['BEE', 'XYZ']);

      await assertBalances(['ali-h'], ['0'], 'BEE');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates a buy order for user added pair', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "123.456" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.1" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNoErrorInLastBlock();

      const result = await database1.findOne({
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
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not create a buy order if pair does not exist', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "123.456" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.1" }'));


      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[5], 'pair does not exist');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates a sell order for user added pair', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNoErrorInLastBlock();

      const result = await database1.findOne({
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
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not create a sell order if pair does not exist', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));


      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[4], 'pair does not exist');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('buys from one seller', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "18.17" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['0', '100'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['16', '2.17'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('buys from multiple sellers', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"nomi", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"punkman", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'punkman', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'nomi', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.17" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "24.3" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "135", "price": "0.18" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0', '0', '50', '135'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['16', '1.7', '4.5', '2.1'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['25'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sells to one buyer', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "55" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.17" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'james'], ['0', '100'], 'BEE');
      await assertBalances(['ali-h', 'james'], ['17', '38'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sells to multiple buyers', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "punkman", "quantity": "18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "nomi", "quantity": "18" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'punkman', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'nomi', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.17" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"james", "quantity":"140", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "140", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['40', '50', '50', '0'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['2', '9.5', '9', '23.9'], 'TKN');
      await assertBalances(['dmarket'], ['9.6'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('market buy from multiple sellers', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"nomi", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"punkman", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'punkman', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "100", "price": "0.16" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'nomi', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.17" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "james", "quantity": "22.2" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "22.2" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0', '0', '50', '135'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['16', '1.7', '4.5', '0'], 'TKN');
      await assertBalances(['dmarket'], ['0'], 'TKN', true);
      await assertBalances(['dmarket'], ['25'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('market sell to multiple buyers', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "punkman", "quantity": "10" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "ali-h", "quantity": "50" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "nomi", "quantity": "12" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), 'punkman', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "55", "price": "0.18" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "312", "price": "0.16" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'nomi', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "50", "price": "0.17" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"james", "quantity":"210", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'james', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "210" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // const res = await database1.getLatestBlockInfo();
      // const txs = res.transactions;

      await assertNoErrorInLastBlock();

      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['105', '50', '55', '0'], 'BEE');
      await assertBalances(['ali-h', 'nomi', 'punkman', 'james'], ['0.08', '3.5', '0.1', '35.2'], 'TKN');
      await assertBalances(['dmarket'], ['33.12'], 'TKN', true);
      await assertBalances(['dmarket'], ['0'], 'BEE', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('verify metrics', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"600", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "quoteToken": "TKN", "baseToken": "BEE" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a001", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a002", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"a003", "quantity":"100", "isSignedWithActiveKey":true }`));

      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b001", "quantity": "100" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b002", "quantity": "100" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "to": "b003", "quantity": "100" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      // bid
      transactions = [];
      transactions = [];

      transactions.push(new Transaction(38145386, getNextTxId(), 'b001', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.15" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'b002', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.20" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'b003', 'dmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.16" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0', '0.20');

      // ask
      transactions = [];
      transactions = [];

      transactions.push(new Transaction(38145386, getNextTxId(), 'a001', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.23" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'a003', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.21" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'a002', 'dmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "10", "price": "0.25" }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0.21', '0.20');

      // update after order filling
      transactions = [];
      transactions = [];

      // sell to the highest bid
      transactions.push(new Transaction(38145386, getNextTxId(), 'a001', 'dmarket', 'marketSell', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "20" }'));

      // buy from the lowest ask
      transactions.push(new Transaction(38145386, getNextTxId(), 'b001', 'dmarket', 'marketBuy', '{ "isSignedWithActiveKey": true, "symbol": "BEE", "quoteToken": "TKN", "quantity": "4.4" }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await verifyAskBid('BEE', 'TKN', '0.25', '0.15');

      const metric = await database1.findOne({
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
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
