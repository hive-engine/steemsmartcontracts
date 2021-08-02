
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

async function assertBalances(accounts, balances, symbol) {
  const res = await database1.find({
    contract: 'tokens',
    table: 'balances',
    query: {
      account: {
        $in: accounts,
      },
      symbol,
    },
  });

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    const {
      balance,
    } = res.find(el => el.account === account);
    const expectedBalance = balances[i];

    // console.log(expectedBalance, balance, account);
    const isEqual = BigNumber(expectedBalance).eq(balance);
    assert(isEqual, `expected @${account} balance ${expectedBalance} instead got ${balance}`);
  }
}

async function assertPair(pair, symbols) {
  const res = await database1.findOne({
    contract: 'dmarket',
    table: 'pairs',
    query: {
      pair,
    },
  });

  console.log(res);

  assert(res, 'pair not found');

  if (symbols !== true) {
    assert(res.allowedSymbols !== true, 'pair is global');
    symbols.forEach((symbol) => {
      assert(res.allowedSymbols.includes(symbol), `symbol ${symbol} not found in pair`);
    });
  } else assert(res.allowedSymbols === true, 'pair is not global');
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
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": false, "pair": "TKN", "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": 5, "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": 5 }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "BEE", "symbol": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));

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
      assertError(txs[3], 'invalid pair');
      assertError(txs[4], 'invalid symbol');
      assertError(txs[5], 'pair and symbol can not be the same');
      assertError(txs[6], 'symbol does not exist');
      assertError(txs[7], 'pair symbol does not exist');
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));

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

  it('does not add symbol into existing pair', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"700", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'dmarket', 'addGlobalPair', '{ "pair": "TKN" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "XYZ" }'));


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

      assertError(txs[6], 'symbol is already in the pair');
      assertError(txs[8], 'can not add symbol to a global pair');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds symbol into existing pair', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dmarketContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "XYZ", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "BEE" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'dmarket', 'addPair', '{ "isSignedWithActiveKey": true, "pair": "TKN", "symbol": "XYZ" }'));

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
});
