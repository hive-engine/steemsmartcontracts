/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

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

function setupContractPayload(name, file) {
  let contractCode = fs.readFileSync(file);
  contractCode = contractCode.toString();
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);

  const base64ContractCode = Base64.encode(contractCode);

  return {
    name,
    params: '',
    code: base64ContractCode,
  };
}

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const contractPayload = setupContractPayload('claimdrops', './contracts/claimdrops.js');

let txId = 1;
function getNextTxId() {
  txId += 1;
  return `TXID${txId.toString().padStart(8, '0')}`;
}

async function assertClaimdrop(claimdropId, reverse = false) {
  const res = await database1.findOne({
    contract: 'claimdrops',
    table: 'claimdrops',
    query: {
      claimdropId,
    },
  });

  if (!reverse) assert.ok(res, `pendingAirdrop ${claimdropId} not found.`);
  else assert.ok(!res, `pendingAirdrop ${claimdropId} is unexpected.`);
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

// smart contract
describe('Airdrops Smart Contract', function () {
  this.timeout(20000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
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

  it('should not create claimdrop', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": 0.001 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": 1000 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": "500" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": 50 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": 5 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": 5 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1", "list": ["ali-h", "1000"] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN.TEST", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "-0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.000000001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "-1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1.0000000001", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": -100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2000-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "in two days", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2030-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "lol", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "542", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "tkns", "beneficiaryType": "c", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "60", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "-1" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "limit": "0.0005" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["", ""]] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["0ali--h", ""]] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["ali-h", ""]] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["ali-h", "SEVEN"]] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["ali-h", "-50"]] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["ali-h", "2.00005"]] }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[4], 'you must use a custom_json signed with your active key');
      assertError(txs[5], 'invalid params'); // invalid symbol
      assertError(txs[6], 'invalid params'); // invalid price
      assertError(txs[7], 'invalid params'); // invalid pool
      assertError(txs[8], 'invalid params'); // invalid maxClaims
      assertError(txs[9], 'invalid params'); // invalid expiry
      assertError(txs[10], 'invalid params'); // invalid beneficiary
      assertError(txs[11], 'invalid params'); // invalid beneficiaryType
      assertError(txs[12], 'invalid params'); // without limit & list
      assertError(txs[13], 'invalid params'); // invalid limit
      assertError(txs[14], 'invalid params'); // invalid list
      assertError(txs[15], 'invalid params'); // with both limit & list
      assertError(txs[16], 'symbol does not exist');
      assertError(txs[17], 'price must be positive');
      assertError(txs[18], 'price precision mismatch');
      assertError(txs[19], 'pool must be positive');
      assertError(txs[20], 'pool precision mismatch');
      assertError(txs[21], 'maxClaims must be positive number');
      assertError(txs[22], 'invalid expiry'); // already exprired according to blockTime
      assertError(txs[23], 'invalid expiry'); // invalid expiry
      assertError(txs[24], 'expiry exceeds limit');
      assertError(txs[25], 'invalid beneficiaryType');
      assertError(txs[26], 'invalid beneficiary'); // invalid username
      assertError(txs[27], 'invalid beneficiary'); // invalid contract name
      assertError(txs[28], 'you must have enough tokens to cover the creation fee');
      assertError(txs[30], 'you must have enough tokens to cover the claimdrop pool');
      assertError(txs[32], 'limit must be positive');
      assertError(txs[33], 'limit precision mismatch');
      assertError(txs[34], 'list cannot be empty');
      assertError(txs[35], 'list[0]: account name cannot be undefined');
      assertError(txs[36], 'list[0]: invalid account name');
      assertError(txs[37], 'list[0]: limit cannot be undefined');
      assertError(txs[38], 'list[0]: invalid limit');
      assertError(txs[39], 'list[0]: limit must be positive');
      assertError(txs[40], 'list[0]: limit precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should create a claimdrop', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "ali-h", "quantity": "160", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'tokens', 'issue', '{ "symbol": "TKN", "to": "ali-h", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'claimdrops', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TKN", "price": "0.001", "pool": "1000", "maxClaims": 100, "expiry": "2020-12-01T00:00:00", "beneficiary": "ali-h", "beneficiaryType": "u", "list": [["ali-h", "9.999"], ["thesim", "5000"], ["harpagon", "500.2"]] }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2020-11-11T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[5].logs);
      const claimdropEvent = eventLog.events.find(x => x.event === 'create');
      assert.equal(claimdropEvent.data.claimdropId, txs[5].transactionId);

      await assertClaimdrop(claimdropEvent.data.claimdropId);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
