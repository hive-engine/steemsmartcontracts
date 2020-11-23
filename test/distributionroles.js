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

// contract-specific constants
const DUST_WEIGHT = 10;

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
const contractPayload = setupContractPayload('distributionroles', './contracts/distributionroles.js');
const miningPayload = setupContractPayload('mining', 'contracts/mining.js');

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

async function assertCandidateWeight(id, account, weight) {
  const res = await database1.findOne({
    contract: 'distributionroles',
    table: 'batches',
    query: { _id: id }
  });
  const cand = res.candidates.find(x => x.account === account);
  if (cand === undefined) return null;
  assert.strictEqual(cand.weight, weight, `${account} has ${cand.weight} weight, expected ${weight}`);
}

async function assertCandidateRank(id, account, rank) {
  const res = await database1.findOne({
    contract: 'distributionroles',
    table: 'batches',
    query: { _id: id }
  });
  const cands = res.candidates.filter(x => x.weight > DUST_WEIGHT).sort((a, b) => api.BigNumber(a.weight).minus(b.weight));
  let candRank = cands.findIndex(x => x.account === account);
  if (candRank === -1) return null;
  else candRank += 1;
  assert.strictEqual(candRank, rank, `${account} has rank ${candRank}, expected ${rank}`);
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

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await database1.findOne({
    contract: 'distributionroles',
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

async function getLastDistributionId() {
  let blk = await database1.getLatestBlockInfo();
  let eventLog = JSON.parse(blk.transactions[8].logs);
  let createEvent = eventLog.events.find(x => x.event === 'create');
  return createEvent.data.id;
}

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// distribution test suite
describe('distributionroles', function () {
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

  it('should accept votes and update weights', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'stake', '{ "to":"donchate", "symbol": "TKN", "quantity": "250", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distributionroles', 'create', '{ "roles": [{ "name": "President", "description": "El Presidente", "pct": 50, "primary": 1},{"name": "Vice President", "description": "El Presidente Jr.", "pct": 25, "primary": 2},{"name": "Developer", "description": "Responsible for xxxxx", "pct": 25, "primary": 4}], "stakeSymbol": "TKN", "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distributionroles', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'berniesanders', 'distributionroles', 'apply', `{ "id": ${id}, "role": "President" }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distributionroles', 'vote', `{ "id": ${id}, "role": "President", "to": "berniesanders", "isSignedWithActiveKey": true }`));

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
      // expected results
      await assertCandidateWeight(id, 'berniesanders', '250.00000000');
      await assertCandidateRank(id, 'berniesanders', 1);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should allow anyone to apply and resign from candidacy', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "500", "to": "donchate", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'stake', '{ "to":"donchate", "symbol": "TKN", "quantity": "250", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'distributionroles', 'create', '{ "roles": [{ "name": "President", "description": "El Presidente", "pct": 50, "primary": 1},{"name": "Vice President", "description": "El Presidente Jr.", "pct": 25, "primary": 2},{"name": "Developer", "description": "Responsible for xxxxx", "pct": 25, "primary": 4}], "stakeSymbol": "TKN", "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'distributionroles', 'setActive', `{ "id": ${id}, "active": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'berniesanders', 'distributionroles', 'apply', `{ "id": ${id}, "role": "President" }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'jeffberwick', 'distributionroles', 'apply', `{ "id": ${id}, "role": "Vice President" }`));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertCandidateRank(id, 'berniesanders', 0);
      await assertCandidateRank(id, 'jeffberwick', 0);

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'berniesanders', 'distributionroles', 'resign', `{ "id": ${id}, "role": "President" }`));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'jeffberwick', 'distributionroles', 'resign', `{ "id": ${id}, "role": "Vice President" }`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertCandidateRank(id, 'berniesanders', null);
      await assertCandidateRank(id, 'jeffberwick', null);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  
});
