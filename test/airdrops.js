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

const conf = {
  chainId: "test-chain-id",
  genesisHiveBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.hive.blog"],
};

let plugins = {};
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
const contractPayload = setupContractPayload('airdrops', './contracts/airdrops.js');

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

async function assertPendingAirdrop(airdropId, reverse = false) {
  let res = await database1.findOne({
      contract: 'airdrops',
      table: 'pendingAirdrops',
      query: {
        airdropId,
      }
    });

  if (!reverse)
    assert.ok(res, `pendingAirdrop ${airdropId} not found.`);
  else
    assert.ok(!res, `pendingAirdrop ${airdropId} is unexpected.`);
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

// smart contract
describe('Airdrops Smart Contract', function () {
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

  it('should not initiate airdrop', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": false, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": 1, "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": 1, "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "liquid_transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN.TEST", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "stake", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100.000000002,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi**a:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon,100,satoshi,100,theguruasia,100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "0.3", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[4], 'you must use a custom_json signed with your active key');
      assertError(txs[5], 'invalid params');
      assertError(txs[6], 'invalid params');
      assertError(txs[7], 'invalid params');
      assertError(txs[8], 'invalid type');
      assertError(txs[9], 'symbol does not exist');
      assertError(txs[10], 'staking not enabled');
      assertError(txs[11], 'invalid list'); // by invalid precision
      assertError(txs[12], 'invalid list'); // by invalid account name
      assertError(txs[13], 'invalid list'); // by invalid format
      assertError(txs[14], 'you must have enough tokens to cover the airdrop fee');
      assertError(txs[16], 'you must have enough tokens to do the airdrop');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should initiate airdrop', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', `{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100,roger:20,hiveio:20,guest123:10,theycallmedan:50,aggroed:50,eonwarped:30,leo.voter:20" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      await assertNoErrorInLastBlock();

      let eventLog = JSON.parse(res.transactions[5].logs);
      let initAirdropEvent = eventLog.events.find(x => x.event === 'initAirdrop');
      assert.equal(initAirdropEvent.data.airdropId, txs[5].transactionId);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not run airdrop distribution', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let virtualTransactions = res.virtualTransactions;

      assert.ok(!virtualTransactions[0]);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should run airdrop distribution with transfer method', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', `{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100,roger:20,hiveio:20,guest123:10,theycallmedan:50,aggroed:50,eonwarped:30,leo.voter:20" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      await assertNoErrorInLastBlock();

      let eventLog = JSON.parse(res.transactions[5].logs);
      let initAirdropEvent = eventLog.events.find(x => x.event === 'initAirdrop');
      assert.equal(initAirdropEvent.data.airdropId, txs[5].transactionId);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId);

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
      let transferFromContractEvents = virtualEventLog.events.filter(x => x.event === 'transferFromContract');

      assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
      assert.equal(airdropDistributionEvent.data.list.length, 10);
      assert.equal(transferFromContractEvents.length, 10);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should run airdrop distribution with stake method', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "1101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'enableStaking', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', `{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "stake", "list": "harpagon:100,satoshi:100,theguruasia:100,roger:20,hiveio:20,guest123:10,theycallmedan:50,aggroed:50,eonwarped:30,leo.voter:20" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      await assertNoErrorInLastBlock();

      let eventLog = JSON.parse(res.transactions[6].logs);
      let initAirdropEvent = eventLog.events.find(x => x.event === 'initAirdrop');
      assert.equal(initAirdropEvent.data.airdropId, txs[6].transactionId);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId);

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
      let stakeFromContractEvents = virtualEventLog.events.filter(x => x.event === 'stakeFromContract');

      assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
      assert.equal(airdropDistributionEvent.data.list.length, 10);
      assert.equal(stakeFromContractEvents.length, 10);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should run airdrop distribution seperated between multiple blocks', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "101", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'airdrops', 'updateParams', '{ "maxTransactionsPerBlock": 2 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', `{ "symbol": "TKN", "to": "ali-h", "quantity": "500", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'airdrops', 'initAirdrop', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "type": "transfer", "list": "harpagon:100,satoshi:100,theguruasia:100,roger:20,hiveio:20,guest123:10,theycallmedan:50,aggroed:50,eonwarped:30,leo.voter:20" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      await assertNoErrorInLastBlock();

      let eventLog = JSON.parse(res.transactions[6].logs);
      let initAirdropEvent = eventLog.events.find(x => x.event === 'initAirdrop');
      assert.equal(initAirdropEvent.data.airdropId, txs[6].transactionId);

      await assertPendingAirdrop(initAirdropEvent.data.airdropId);

      for (let i = 0; i < 5; i += 1) {
        transactions = [];
        transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'whatever', 'whatever', ''));

        block = {
          refHiveBlockNumber: 12345678902 + i,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

        res = await database1.getLatestBlockInfo();
        let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        let airdropDistributionEvent = virtualEventLog.events.find(x => x.event === 'airdropDistribution');
        let transferFromContractEvents = virtualEventLog.events.filter(x => x.event === 'transferFromContract');

        assert.ok(airdropDistributionEvent, 'Expected to find airdropDistribution event');
        assert.equal(airdropDistributionEvent.data.list.length, 2);
        assert.equal(transferFromContractEvents.length, 2);
        console.log(airdropDistributionEvent.data.list)

        if (i === 4)
          await assertPendingAirdrop(initAirdropEvent.data.airdropId, true);
        else
          await assertPendingAirdrop(initAirdropEvent.data.airdropId);
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

});
