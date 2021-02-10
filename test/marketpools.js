/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { createVerify } = require('crypto');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: [
    "https://api.hive.blog",
  ],
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null

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
}

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const contractPayload = setupContractPayload('marketpools', './contracts/marketpools.js');

async function assertUserBalance(account, symbol, balance) {
  const res = await database1.findOne({
      contract: 'tokens',
      table: 'balances',
      query: { account, symbol }
    });

  if (!balance) {
    assert(!res, `Balance found for ${account}, ${symbol}, expected none.`);
    return;
  }
  assert.ok(res, `No balance for ${account}, ${symbol}`);
  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
}

async function assertContractBalance(account, symbol, balance) {
  const res = await database1.findOne({
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

async function assertPoolStats(tokenPair, stats) {
  const res = await database1.findOne({
    contract: 'marketpools',
    table: 'pools',
    query: { tokenPair }
  });
  assert.equal(res.baseQuantity, stats.baseQuantity, `baseQuantity has ${res.baseQuantity}, expected ${stats.baseQuantity}`);
  assert.equal(res.quoteQuantity, stats.quoteQuantity, `quoteQuantity has ${res.quoteQuantity}, expected ${stats.quoteQuantity}`);
  assert.equal(res.baseVolume, stats.baseVolume, `baseVolume has ${res.baseVolume}, expected ${stats.baseVolume}`);
  assert.equal(res.quoteVolume, stats.quoteVolume, `quoteVolume has ${res.quoteVolume}, expected ${stats.quoteVolume}`);
  assert.equal(res.basePrice, stats.basePrice, `basePrice has ${res.basePrice}, expected ${stats.basePrice}`);
  assert.equal(res.quotePrice, stats.quotePrice, `quotePrice has ${res.quotePrice}, expected ${stats.quotePrice}`);
}

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await database1.findOne({
    contract: 'marketpools',
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

function assertError(tx, message) {
  const logs = JSON.parse(tx.logs);
  assert(logs.errors, 'No error in logs. Error expected with message ' + message);
  assert.equal(logs.errors[0], message, `Error expected with message ${message}. Instead got ${logs.errors[0]}`);
}

async function assertNoErrorInLastBlock() {
  const transactions = (await database1.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
  }
}

async function assertAllErrorInLastBlock() {
  const transactions = (await database1.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(logs.errors, `Tx #${i} had unexpected success ${logs.errors}`);
  }
}

async function getLastPoolId() {
  let blk = await database1.getLatestBlockInfo();
  let eventLog = JSON.parse(blk.transactions[5].logs);
  let createEvent = eventLog.events.find(x => x.event === 'createPool');
  return createEvent.data.id;
}

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// distribution test suite
describe('marketpools tests', function () {
  this.timeout(30000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
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

  it('should not create invalid pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLDSLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:GLD", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "TKN:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:TKN", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block })

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[5], 'you must use a transaction signed with your active key');
      assertError(txs[6], 'invalid tokenPair format');
      assertError(txs[7], 'tokenPair cannot be the same token');
      assertError(txs[8], 'baseSymbol does not exist');
      assertError(txs[9], 'quoteSymbol does not exist');
      
      res = await database1.find({
        contract: 'marketpools',
        table: 'pools'
      });
  
      assert.ok(!res, 'uncaught errors, invalid pool created');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create valid pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      // console.log(blk);
      await assertNoErrorInLastBlock();
      const id = await getLastPoolId();
      let res = await database1.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'newly created pool not found');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should allow owner to update params', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketpools', 'updateParams', '{ "poolCreationFee": "2000" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      await assertNoErrorInLastBlock();
      let res = await database1.findOne({
        contract: 'marketpools',
        table: 'params',
        query: {},
      });
      assert.ok(res.poolCreationFee === '2000', 'fee has not changed');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should not add liquidity to invalid pairs/pools', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "x", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "500", "quoteQuantity": "x", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:TKN", "baseQuantity": "500", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "500", "quoteQuantity": "500", "isSignedWithActiveKey": true }'));      

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block })

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[6], 'you must use a transaction signed with your active key');
      assertError(txs[7], 'invalid baseQuantity');
      assertError(txs[8], 'invalid quoteQuantity');
      assertError(txs[9], 'quoteSymbol does not exist');
      assertError(txs[15], 'constant price 1, expected 16.00000000');
      
      res = await database1.findOne({
        contract: 'marketpools',
        table: 'liquidityPosition',
        query: { tokenPair: "GLD:SLV", account: "whale" },
      });
  
      assert.ok(!res, 'uncaught errors, invalid LP created');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should add liquidity and update positions', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      await assertNoErrorInLastBlock();
      let lpos = await database1.findOne({
        contract: 'marketpools',
        table: 'liquidityPosition',
        query: {
          _id: 1
        }
      });
      let lpool = await database1.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: {
          _id: 1
        }
      });
      assert.ok(lpos, 'newly created LP not found');
      assert.ok(lpos.baseQuantity === '1000', `LP baseQuantity not as expected - ${lpos.baseQuantity}`);
      assert.ok(lpos.quoteQuantity === '16000', `LP quoteQuantity not as expected - ${lpos.quoteQuantity}`);
      assert.ok(lpool.basePrice === '16.00000000', `pool price not as expected - ${lpool.basePrice}`);
      assert.ok(lpool.baseQuantity === '1001', `pool baseQuantity not as expected - ${lpool.baseQuantity}`);
      assert.ok(lpool.quoteQuantity === '16016', `pool quoteQuantity not as expected - ${lpool.quoteQuantity}`);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should remove liquidity and update positions', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "16000", "to": "whale", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1000", "quoteQuantity": "16000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'whale', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'investor', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "2", "quoteQuantity": "32", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'whale', 'marketpools', 'removeLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "1", "quoteQuantity": "16", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      await assertNoErrorInLastBlock();
      let lpos = await database1.findOne({
        contract: 'marketpools',
        table: 'liquidityPosition',
        query: {
          tokenPair: "GLD:SLV",
          account: "investor"
        }
      });
      let lpos2 = await database1.findOne({
        contract: 'marketpools',
        table: 'liquidityPosition',
        query: {
          tokenPair: "GLD:SLV",
          account: "whale"
        }
      });      
      let lpool = await database1.findOne({
        contract: 'marketpools',
        table: 'pools',
        query: {
          _id: 1
        }
      });
      assert.ok(lpos, 'active LP not found');
      assert.ok(!lpos2, 'supposed to be deleted LP found');
      assert.ok(lpos.baseQuantity === '998', `LP baseQuantity not as expected - ${lpos.baseQuantity}`);
      assert.ok(lpos.quoteQuantity === '15968', `LP quoteQuantity not as expected - ${lpos.quoteQuantity}`);
      assert.ok(lpool.basePrice === '16.00000000', `pool price not as expected - ${lpool.basePrice}`);
      assert.ok(lpool.baseQuantity === '998', `pool baseQuantity not as expected - ${lpool.baseQuantity}`);
      assert.ok(lpool.quoteQuantity === '15968', `pool quoteQuantity not as expected - ${lpool.quoteQuantity}`);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should swap tokens in either direction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "20000", "to": "investor", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "buyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'marketpools', 'create', '{ "tokenPair": "GLD:SLV", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'investor', 'marketpools', 'addLiquidity', '{ "tokenPair": "GLD:SLV", "baseQuantity": "100", "quoteQuantity": "1000", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'buyer', 'marketpools', 'swapTokensForExactTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenOut": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'buyer', 'marketpools', 'swapTokensForExactTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenOut": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'buyer', 'marketpools', 'swapExactTokensForTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "GLD", "tokenIn": "1", "isSignedWithActiveKey": true}'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'buyer', 'marketpools', 'swapExactTokensForTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenIn": "1", "isSignedWithActiveKey": true}'));
      // for (let i = 0; i <= 100; i++) {
      //   transactions.push(new Transaction(12345678902, getNextTxId(), 'buyer', 'marketpools', 'swapExactTokensForTokens', '{ "tokenPair": "GLD:SLV", "tokenSymbol": "SLV", "tokenIn": "1", "isSignedWithActiveKey": true}'));
      // }

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      console.log(res);
      await assertNoErrorInLastBlock();

      // verify swap execution
      await assertUserBalance('buyer', 'SLV', 999.98010970);
      await assertUserBalance('buyer', 'GLD', 1000.00198899);
      await assertContractBalance('marketpools', 'SLV', 1000.01989030);
      await assertContractBalance('marketpools', 'GLD', 99.99801101);

      // verify pool stats execution
      await assertPoolStats('GLD:SLV', {
        baseQuantity: 99.99801100987021029561,
        quoteQuantity: 1000.019890296913939448,
        basePrice: 10.00039781,
        quotePrice: 0.09999602,
        baseVolume: 2.19820325,
        quoteVolume: 22.18212990,
      });
     
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  
/*
  it('should not accept deposits when inactive or invalid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastPoolId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": 100, "isSignedWithActiveKey": true}`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'distribution must be active to deposit');

      // should still be as initialized
      await assertUserBalance('donchate', 'TKN', 500);
      await assertUserBalance('dantheman', 'TKN');

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": 100, "isSignedWithActiveKey": false}`));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100x", "isSignedWithActiveKey": true}`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      txs = res.transactions;

      assertError(txs[1], 'you must use a custom_json signed with your active key');
      assertError(txs[2], 'invalid quantity');

      // should still be as initialized
      await assertUserBalance('donchate', 'TKN', 500);
      await assertUserBalance('dantheman', 'TKN');
     
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should distribute payments on deposit exceeding tokenMinPayout', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastPoolId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // should be no errors
      await assertNoErrorInLastBlock();

      // should be redistributed
      await assertUserBalance('donchate', 'TKN', 450);
      await assertUserBalance('dantheman', 'TKN', 50);

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
  
  it('should hold payments on deposit not exceeding tokenMinPayout', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));      

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastPoolId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // should be no errors
      await assertNoErrorInLastBlock();

      // should be as initialized
      await assertUserBalance('donchate', 'TKN', 495);
      await assertUserBalance('dantheman', 'TKN');

      // should have tokenBalance
      await assertTokenBalance(id, 'TKN', 5);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });    

  it('should distribute payments on flush', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastPoolId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'flush', `{ "id": ${id}, "symbol": "TKN", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // should be no errors
      await assertNoErrorInLastBlock();

      // should be redistributed
      await assertUserBalance('donchate', 'TKN', 497.5);
      await assertUserBalance('dantheman', 'TKN', 2.5);

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should distribute payments to both users and contracts for multiple tokens', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10},{"symbol": "TKNA", "quantity": 5}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 25},{"account": "airdrops", "type": "contract", "pct": 25}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNA", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKNA", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastPoolId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKNA", "quantity": "100", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // should be no errors
      await assertNoErrorInLastBlock();

      // should be redistributed
      await assertUserBalance('donchate', 'TKN', 450);
      await assertUserBalance('donchate', 'TKNA', 450);
      await assertUserBalance('dantheman', 'TKN', 25);
      await assertUserBalance('dantheman', 'TKNA', 25);
      await assertContractBalance('airdrops', 'TKN', 25);
      await assertContractBalance('airdrops', 'TKNA', 25);

      // contract should be flushed
      await assertTokenBalance(id, 'TKN', 0);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  
*/
});
