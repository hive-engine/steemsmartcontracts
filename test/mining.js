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
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.steemit.com"],
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
const contractPayload = setupContractPayload('mining', './contracts/mining.js');

async function assertUserBalances(account, symbol, balance, stake, delegationsIn) {
  let res = await database1.findOne({
      contract: 'tokens',
      table: 'balances',
      query: {
        account,
        symbol,
      }
    });

  assert.ok(res, `No balance for ${account}, ${symbol}`);

  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
  assert.equal(res.stake, stake, `${account} has ${symbol} stake ${res.stake}, expected ${stake}`);
  if (delegationsIn) {
    assert.equal(res.delegationsIn, delegationsIn, `${account} has ${symbol} delegationsIn ${res.delegationsIn}, expected ${delegationsIn}`);
  }
}

async function assertMiningPower(account, id, power) {
  let res = await database1.findOne({
      contract: 'mining',
      table: 'miningPower',
      query: {
        id,
        account,
      }
    });
  assert.ok(res, `No power for ${account} in pool ${id}`);

  assert.equal(res.power['$numberDecimal'], power, `${account} has ${id} power ${res.power['$numberDecimal']}, expected ${power}`);
}

async function assertPool(pool) {
  const { id } = pool;
  let res = await database1.findOne({
      contract: 'mining',
      table: 'pools',
      query: {
        id,
      }
    });

  assert.ok(res, `Pool ${id} not found.`);

  Object.keys(pool).forEach(k => {
    assert.equal(res[k], pool[k], `Pool ${id} has ${k} ${res[k]}, expected ${pool[k]}`);
  });
}

async function assertTokenPool(symbol, poolId) {
  let res = await database1.findOne({
      contract: 'mining',
      table: 'tokenPools',
      query: {
        symbol,
        id: poolId,
      }
    });

  assert.ok(res, `Token pool ${poolId} not found for ${symbol}.`);
}

async function assertTotalStaked(amount, symbol='TKN') {
    let res = await database1.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
            symbol,
        },
    });

    assert.equal(res.totalStaked, amount, `${symbol} has ${res.totalStaked} staked, expected ${amount}`);
}

async function assertParams(key, value) {
    let res = await database1.findOne({
        contract: 'tokens',
        table: 'params',
        query: {},
    });
    assert.equal(res[key], value, `Params for ${key} is ${res[key]}, expected ${value}`);
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

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// smart tokens
describe('mining', function () {
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

  it('should not create mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": 0 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": 2, "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "12345678901", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": "1", "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 0, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 21, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": "0", "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 0, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 721, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "NOTKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": "tokenMiners", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1, "TKN2": 2, "TKN3": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"NOTKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"MTKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"MTKN": "garbage"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"MTKN": 0}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"MTKN": 101}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "-1", "minedToken": "TKN", "tokenMiners": {"MTKN": 1}, "isSignedWithActiveKey": true }'));

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

      assertError(txs[6], 'you must have enough tokens to cover the creation fee');
      assertError(txs[8], 'you must use a custom_json signed with your active key');
      assertError(txs[9], 'invalid params');
      assertError(txs[10], 'invalid params');
      assertError(txs[11], 'invalid symbol: uppercase letters only, max length of 10');
      assertError(txs[12], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[13], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[14], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[15], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[16], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[17], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[18], 'minedToken does not exist');
      assertError(txs[20], 'must be issuer of minedToken');
      assertError(txs[21], 'minedToken precision mismatch for lotteryAmount');
      assertError(txs[22], 'tokenMiners invalid');
      assertError(txs[23], 'only 1 or 2 tokenMiners allowed');
      assertError(txs[26], 'tokenMiners must have staking enabled');
      assertError(txs[27], 'tokenMiners must have staking enabled');
      assertError(txs[29], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[30], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[31], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[32], 'invalid params');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should update mining power on stake and delegation updates', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1, "MTKN": 4}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN_MTKN');
      await assertTokenPool('MTKN', 'TKN-TKN_MTKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '75.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '20.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '50');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '100');
      await assertPool({id: 'TKN-TKN_MTKN', totalPower: '150'});

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi2", "symbol": "MTKN", "quantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '40.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '30.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '60');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '140');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '200' });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "to": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi2', 'tokens', 'delegate', '{ "to": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '35.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '5.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '25.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '75');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '125');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '200' });

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "from": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi2', 'tokens', 'undelegate', '{ "from": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '35.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '0.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '0.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '25.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '55');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '120');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '175' });

      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '40.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '0.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '0.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '30.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '60');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '140');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '200' });

      transactions = [];
      const unstakeId = getNextTxId();
      const unstakeId2 = getNextTxId();
      transactions.push(new Transaction(12345678906, unstakeId, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678906, unstakeId2, 'satoshi2', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678906,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '39.99999998');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '0.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '0.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '29.99999998');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '59.99999998');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '139.99999992');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '199.9999999' });

      transactions = [];
      transactions.push(new Transaction(12345678907, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678907,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertUserBalances('satoshi', 'TKN', '40.00000002', '39.99999995');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '0.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '0.00000000');
      await assertUserBalances('satoshi2', 'MTKN', '0.00000002', '29.99999995');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '59.99999996');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '139.99999984');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '199.9999998' });

      transactions = [];
      transactions.push(new Transaction(12345678908, getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678908, getNextTxId(), 'satoshi2', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId2}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678908,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertUserBalances('satoshi', 'TKN', '40.00000002', '39.99999998');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '0.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '0.00000000');
      await assertUserBalances('satoshi2', 'MTKN', '0.00000002', '29.99999998');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '59.99999999');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '139.99999996');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '199.99999995' });

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1, "MTKN": 4}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN_MTKN');
      await assertPool({id: 'TKN-TKN_MTKN', totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "300", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": 2, "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "blah", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "-15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2.7, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 0, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 21, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN9", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolUpdateFee": 0 }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 2}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "NOTKN": 3}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 101}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 0}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": "a"}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'you must have enough tokens to cover the update fee');
      assertError(txs[2], 'you must use a custom_json signed with your active key');
      assertError(txs[3], 'invalid params');
      assertError(txs[4], 'invalid params');
      assertError(txs[5], 'invalid params');
      assertError(txs[6], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[7], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[8], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[9], 'pool id not found');
      assertError(txs[11], 'must be issuer of minedToken');
      assertError(txs[12], 'minedToken precision mismatch for lotteryAmount');
      assertError(txs[13], 'cannot change tokenMiners keys');
      assertError(txs[14], 'can only modify existing tokenMiner multiplier');
      assertError(txs[15], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[16], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[17], 'tokenMiner multiplier must be an integer from 1 to 100');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7300", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "11", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1, "MTKN": 4}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN_MTKN');
      await assertTokenPool('MTKN', 'TKN-TKN_MTKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '84.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '11.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '50');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '64');
      await assertPool({id: 'TKN-TKN_MTKN', totalPower: '114', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN_MTKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": {"TKN": 2, "MTKN": 3}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN_MTKN');
      await assertTokenPool('MTKN', 'TKN-TKN_MTKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '84.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '11.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '75');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '73');
      await assertPool({id: 'TKN-TKN_MTKN', totalPower: '148', lotteryWinners: 2, lotteryIntervalHours: 3, lotteryAmount: "15.7", nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime() });

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it.only('should not run basic lottery when inactive', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "active": false, "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN');

      await assertPool({ id: 'TKN-TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime(), active: false });

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
      let res = (await database1.getLatestBlockInfo());

      assert(res.virtualTransactions.length === 0);

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN-TKN", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "active": true, "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
      await assertNoErrorInLastBlock();

      res = (await database1.getLatestBlockInfo());
      assert(res.virtualTransactions.length === 0);

      await assertPool({ id: 'TKN-TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime(), active: true });

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T03:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
      res = (await database1.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN-TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi2");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', '1.00000000', '10.00000000');



      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should run basic lottery', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN');

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '10.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN', '50');
      await assertMiningPower('satoshi2', 'TKN-TKN', '10');
      await assertPool({ id: 'TKN-TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() });

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
      let res = (await database1.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN-TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '41.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '10.00000000');

      // run a few more times and count frequencies
      const winnerCount = { 'satoshi': 0, 'satoshi2': 0 };
      const lotteryDate = new Date('2018-06-01T01:00:00.000Z');
      for (let i = 0; i < 10; i += 1) {
        transactions = [];
        transactions.push(new Transaction(12345678904 + i, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        lotteryDate.setHours(lotteryDate.getHours() + i + 1);
        block = {
          refHiveBlockNumber: 12345678904 + i,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: lotteryDate.toISOString().replace('.000Z', ''),
          transactions,
        };
        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
        res = (await database1.getLatestBlockInfo());
        virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');

        assert.ok(lotteryEvent, 'Expected to find miningLottery event');
        assert.equal(lotteryEvent.data.poolId, 'TKN-TKN');
        assert.equal(lotteryEvent.data.winners.length, 1);
        winnerCount[lotteryEvent.data.winners[0].winner] += 1;
      }
      assert.equal(Object.values(winnerCount).reduce((x,y) => x+y, 0), 10);
      assert(winnerCount['satoshi'] > winnerCount['satoshi2']);
      await assertUserBalances('satoshi', 'TKN', (41 + winnerCount['satoshi']).toFixed(8), '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', winnerCount['satoshi2'].toFixed(8), '10.00000000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should run basic lottery with 2 tokenMiners', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": {"TKN": 1, "MTKN": 4}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN-TKN_MTKN');
      await assertTokenPool('MTKN', 'TKN-TKN_MTKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '75.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '20.00000000');

      await assertMiningPower('satoshi', 'TKN-TKN_MTKN', '50');
      await assertMiningPower('satoshi2', 'TKN-TKN_MTKN', '100');
      await assertPool({ id: 'TKN-TKN_MTKN', totalPower: '150', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() });

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
      let res = (await database1.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN-TKN_MTKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '51.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');

      // run a few more times and count frequencies
      const winnerCount = { 'satoshi': 0, 'satoshi2': 0 };
      const lotteryDate = new Date('2018-06-01T01:00:00.000Z');
      for (let i = 0; i < 20; i += 1) {
        transactions = [];
        transactions.push(new Transaction(12345678904 + i, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        lotteryDate.setHours(lotteryDate.getHours() + i + 1);
        block = {
          refHiveBlockNumber: 12345678904 + i,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: lotteryDate.toISOString().replace('.000Z', ''),
          transactions,
        };
        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
        res = (await database1.getLatestBlockInfo());
        virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');

        assert.ok(lotteryEvent, 'Expected to find miningLottery event');
        assert.equal(lotteryEvent.data.poolId, 'TKN-TKN_MTKN');
        assert.equal(lotteryEvent.data.winners.length, 1);
        winnerCount[lotteryEvent.data.winners[0].winner] += 1;
      }
      assert.equal(Object.values(winnerCount).reduce((x,y) => x+y, 0), 20);
      assert(winnerCount['satoshi'] < winnerCount['satoshi2']);
      await assertUserBalances('satoshi', 'TKN', (51 + winnerCount['satoshi']).toFixed(8), '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', winnerCount['satoshi2'].toFixed(8), '20.00000000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

});
