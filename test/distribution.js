/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');

const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');

const { CONSTANTS } = require('../libs/Constants');
const { createVerify } = require('crypto');

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

function setupContractPayload(name, file) {
  let contractCode = fs.readFileSync(file);
  contractCode = contractCode.toString();
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);

  let base64ContractCode = Base64.encode(contractCode);

  return {
    name,
    params: '',
    code: base64ContractCode,
  };
}

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const contractPayload = setupContractPayload('distribution', './contracts/distribution.js');

async function assertUserBalance(account, symbol, balance) {
  let res = await database1.findOne({
      contract: 'tokens',
      table: 'balances',
      query: {
        account,
        symbol,
      }
    });

  if (!balance) {
    assert(!res, `Balance found for ${account}, ${symbol}, expected none.`);
    return;
  }
  assert.ok(res, `No balance for ${account}, ${symbol}`);
  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
}

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await database1.findOne({
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

async function assertNoErrorInLastBlock() {
  const transactions = (await database1.getLatestBlockInfo()).transactions;
  // console.log(transactions);
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

async function getLastDistributionId() {
  let blk = await database1.getLatestBlockInfo();
  let eventLog = JSON.parse(blk.transactions[4].logs);
  let createEvent = eventLog.events.find(x => x.event === 'create');
  return createEvent.data.id;
}

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// distribution test suite
describe('distribution', function () {
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

  it('should not create invalid distribution', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [], "tokenRecipients": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX", "quantity": 1}], "tokenRecipients": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [{"account": "donchate"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 1},{"account": "harpagon", "pct": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": "x"}], "tokenRecipients": [{"account": "donchate", "pct": "x"},{"account": "harpagon", "pct": "x"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "harpagon", "pct": 60}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "donchate", "pct": 40}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 1},{"symbol": "TKN", "quantity": 2}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "donchate", "pct": 40}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
        contract: 'distribution',
        table: 'batches'
      });
  
      assert.ok(!res, 'invalid distribution created');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create valid distribution', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

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
      const id = await getLastDistributionId();
      let res = await database1.findOne({
        contract: 'distribution',
        table: 'batches',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'newly created distribution not found');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should not set distribution active', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": false }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'setActive', '{ "id": "1000000", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'scriptkiddie', 'distribution', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertAllErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update invalid distribution', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": false }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": 1, "tokenRecipients": 1, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [], "tokenRecipients": 1, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX", "quantity": 1}], "tokenRecipients": [], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "XXX"}], "tokenRecipients": [{"account": "donchate"}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 1}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 1},{"account": "harpagon", "pct": 1}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": "x"}], "tokenRecipients": [{"account": "donchate", "pct": "x"},{"account": "harpagon", "pct": "x"}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "harpagon", "pct": 60}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "donchate", "pct": 40}], "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 1},{"symbol": "TKN", "quantity": 2}], "tokenRecipients": [{"account": "donchate", "pct": 60},{"account": "donchate", "pct": 40}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertAllErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update distribution', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distribution', 'create', '{ "tokenMinPayout": [{"symbol": "TKN", "quantity": 10}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 100}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      const id = await getLastDistributionId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'update', `{ "id": ${id}, "tokenMinPayout": [{"symbol": "TKN", "quantity": 100}], "tokenRecipients": [{"account": "donchate", "type": "user", "pct": 50},{"account": "dantheman", "type": "user", "pct": 50}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      let res = await database1.findOne({
        contract: 'distribution',
        table: 'batches',
        query: {
          _id: id
        }
      });
      assert.ok(res, 'distribution not found');
      assert.strictEqual(res.tokenMinPayout[0].quantity, 100, 'distribution payout quantity not updated');
      assert.strictEqual(res.tokenRecipients[0].pct, 50, 'distribution recipient pct not updated');
      assert.strictEqual(res.tokenRecipients.length, 2, 'distribution recipient addition not updated');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not accept deposits when inactive', (done) => {
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

      const id = await getLastDistributionId();
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distribution', 'deposit', `{ "id": ${id}, "symbol": "TKN", "quantity": 100}`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // should be errored
      await assertAllErrorInLastBlock();

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

      const id = await getLastDistributionId();
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

      const id = await getLastDistributionId();
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

      const id = await getLastDistributionId();
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
});
