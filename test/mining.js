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
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
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

  if (!balance && !stake && !delegationsIn) {
    assert(!res, `Balance found for ${account}, ${symbol}, expected none.`);
    return;
  }
  assert.ok(res, `No balance for ${account}, ${symbol}`);

  assert.equal(res.balance, balance, `${account} has ${symbol} balance ${res.balance}, expected ${balance}`);
  assert.equal(res.stake, stake, `${account} has ${symbol} stake ${res.stake}, expected ${stake}`);
  if (delegationsIn) {
    assert.equal(res.delegationsIn, delegationsIn, `${account} has ${symbol} delegationsIn ${res.delegationsIn}, expected ${delegationsIn}`);
  }
}

async function assertNftInstance(account, symbol, id, delegatedTo) {
  let res = await database1.findOne({
      contract: 'nft',
      table: `${symbol}instances`,
      query: {
        account,
        _id: id,
      }
    });

  assert.ok(res, `No NFT found for ${account}, ${symbol} with ID ${id}`);

  if (delegatedTo) {
    assert.equal(JSON.stringify(res.delegatedTo), JSON.stringify(delegatedTo), `${account} NFT ${symbol} with ID ${id} has delegatedTo ${JSON.stringify(res.delegatedTo)}, expected ${JSON.stringify(delegatedTo)}`);
  } else if (delegatedTo === undefined) {
    assert(res.delegatedTo === undefined, `${account} NFT ${symbol} with ID ${id} has delegatedTo ${JSON.stringify(res.delegatedTo)}, expected undefined`);
  }
}

async function assertMiningPower(account, id, power, nftBalances) {
  let res = await database1.findOne({
      contract: 'mining',
      table: 'miningPower',
      query: {
        id,
        account,
      }
    });
  if (!power) {
    assert(!res, `Power found for ${account} in pool ${id}, expected to be missing.`);
    return;
  }
  assert.ok(res, `No power for ${account} in pool ${id}`);

  if (nftBalances) {
      assert.equal(JSON.stringify(res.nftBalances), JSON.stringify(nftBalances), `${account} has ${id} nft balances ${JSON.stringify(res.nftBalances)}, expected ${JSON.stringify(nftBalances)}`);
  }

  assert.equal(res.power['$numberDecimal'], power, `${account} has ${id} power ${res.power['$numberDecimal']}, expected ${power}`);
}

async function assertPool(pool, updating) {
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
  if (updating) {
    Object.keys(updating).forEach(k => {
      assert.equal(res.updating[k], updating[k], `Pool ${id} has updating.${k} ${res.updating[k]}, expected ${updating[k]}`);
    });
  }
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

async function assertNftTokenPool(symbol, poolId) {
  let res = await database1.findOne({
      contract: 'mining',
      table: 'nftTokenPools',
      query: {
        symbol,
        id: poolId,
      }
    });

  assert.ok(res, `NFT Token pool ${poolId} not found for ${symbol}.`);
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

async function finishPowerUpdate(blockNumber, poolId) {
  const poolQuery = {
      contract: 'mining',
      table: 'pools',
      query: {
          id: poolId,
      }
  };
  let res = await database1.findOne(poolQuery);
  while (res.updating.inProgress) {
    const block = {
      refHiveBlockNumber: blockNumber,
      refHiveBlockId: 'ABCD1',
      prevRefHiveBlockId: 'ABCD2',
      timestamp: '2018-06-01T00:00:00',
      transactions: [new Transaction(blockNumber, getNextTxId(), 'satoshi', 'whatever', 'whatever', '')],
    };
    await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
    res = await database1.findOne(poolQuery);
    blockNumber += 1;
  }
  return blockNumber;
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": 2, "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "12345678901", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": "1", "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 0, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 21, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": "0", "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 0, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 721, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "NOTKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": "tokenMiners", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "TKN2", "multiplier": 2}, {"symbol": "TKN3", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "NOTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": "garbage"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 0}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 101}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "-1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}, {"symbol": "TKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "TKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));

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
      assertError(txs[34], 'pool already exists');
      assertError(txs[35], 'pool already exists');
      assertError(txs[36], 'tokenMiners cannot have duplicate symbols');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.MTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}, {"symbol": "TEST.MTKN", "multiplier": 2}], "isSignedWithActiveKey": true }'));

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

      await assertPool({id: 'TEST-TKN:TEST-MTKN,TEST-TKN', totalPower: '0'});

      let eventLog = JSON.parse(res.transactions[7].logs);
      let createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN:TEST-MTKN,TEST-TKN');
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
  console.log((await database1.getLatestBlockInfo()).virtualTransactions);

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '75.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '20.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'});

      // allow mining power update to resume
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '100');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '150'});

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi2", "symbol": "MTKN", "quantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '40.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '30.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '60');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '140');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "to": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi2', 'tokens', 'delegate', '{ "to": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

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
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000', '5.00000000');
      await assertUserBalances('satoshi', 'MTKN', '65.00000000', '5.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '25.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '75');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '125');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "from": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi2', 'tokens', 'undelegate', '{ "from": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678905,
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

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '55');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '120');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '175' });

      transactions = [];
      transactions.push(new Transaction(12345678906, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678906,
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

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '60');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '140');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      transactions = [];
      const unstakeId = getNextTxId();
      const unstakeId2 = getNextTxId();
      transactions.push(new Transaction(12345678907, unstakeId, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678907, unstakeId2, 'satoshi2', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678907,
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

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999998');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.99999992');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.9999999' });

      transactions = [];
      transactions.push(new Transaction(12345678908, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678908,
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

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999995');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.9999998');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.99999975' });

      transactions = [];
      transactions.push(new Transaction(12345678909, getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678909, getNextTxId(), 'satoshi2', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId2}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678909,
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

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999998');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.99999992');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.9999999' });

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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "300", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": 2, "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "blah", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "-15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2.7, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 0, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 21, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN9", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "NOTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 101}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 0}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": "a"}], "isSignedWithActiveKey": true }'));

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
      assertError(txs[13], 'cannot change which tokens are in tokenMiners');
      assertError(txs[14], 'cannot change which tokens are in tokenMiners');
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

  it('should not set mining pool active', (done) => {
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN9", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'you must use a custom_json signed with your active key');
      assertError(txs[1], 'pool id not found');
      assertError(txs[2], 'must be issuer of minedToken');

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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '84.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '11.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1 });

      // allow mining power update to resume
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '64');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '114', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '84.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '11.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '75');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '73');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '148', lotteryWinners: 2, lotteryIntervalHours: 3, lotteryAmount: "15.7", nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime() });

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update mining pool for utility token as api owner', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', `{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "tokenMiners": [{"symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "multiplier": 1}], "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool(CONSTANTS.UTILITY_TOKEN_SYMBOL, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      await assertPool({id: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`, totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });
      await assertUserBalances(CONSTANTS.HIVE_ENGINE_ACCOUNT, CONSTANTS.UTILITY_TOKEN, '1500011.41552511', 0);

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', `{ "id": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "tokenMiners": [{"symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "multiplier": 1}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool(CONSTANTS.UTILITY_TOKEN_SYMBOL, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);

      await assertPool({id: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`, totalPower: '0', lotteryWinners: 2, lotteryIntervalHours: 3, lotteryAmount: "15.7", nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });

      await assertUserBalances(CONSTANTS.HIVE_ENGINE_ACCOUNT, CONSTANTS.UTILITY_TOKEN, '1500011.41552511', 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not run basic lottery when inactive', (done) => {
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime(), active: false });

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
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));

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

      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime(), active: true });

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
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '41.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', '0', '10.00000000');



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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await assertUserBalances('satoshi', 'TKN', '40.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '10.00000000');

      await assertMiningPower('satoshi', 'TKN:TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:TKN', '10');
      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() });

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
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
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
        assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '20.00000000');
      await assertUserBalances('satoshi', 'MTKN', '75.00000000', '5.00000000');
      await assertUserBalances('satoshi2', 'MTKN', 0, '20.00000000');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1 });

      // allow mining power update to resume
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '100');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '150', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
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
      assert.equal(lotteryEvent.data.poolId, 'TKN:MTKN,TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi2");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '50.00000000', '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', '1.00000000', '20.00000000');

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
        assert.equal(lotteryEvent.data.poolId, 'TKN:MTKN,TKN');
        assert.equal(lotteryEvent.data.winners.length, 1);
        winnerCount[lotteryEvent.data.winners[0].winner] += 1;
      }
      assert.equal(Object.values(winnerCount).reduce((x,y) => x+y, 0), 20);
      assert(winnerCount['satoshi'] < winnerCount['satoshi2']);
      await assertUserBalances('satoshi', 'TKN', (50 + winnerCount['satoshi']).toFixed(8), '30.00000000');
      await assertUserBalances('satoshi2', 'TKN', (1 + winnerCount['satoshi2']).toFixed(8), '20.00000000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should cap lotteries run', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "5200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKNB", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKNB", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKNB:TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await assertUserBalances('harpagon', 'TKN', '0.00000000', 0);
      await assertUserBalances('satoshi', 'TKN', '40.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '10.00000000');

      await assertMiningPower('satoshi', 'TKN:TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:TKN', 0);
      await assertPool({ id: 'TKN:TKN', totalPower: '50', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 7, tokenIndex: 0 });
      await assertPool({ id: 'TKNB:TKN', totalPower: '0', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 0, tokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi2', 'TKN:TKN', '10');
      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });
      await assertPool({ id: 'TKNB:TKN', totalPower: '0', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 0, tokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi', 'TKNB:TKN', '50');
      await assertMiningPower('satoshi2', 'TKNB:TKN', 0);
      await assertPool({ id: 'TKNB:TKN', totalPower: '50', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 7, tokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi2', 'TKNB:TKN', '10');
      await assertPool({ id: 'TKNB:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });

      let res = (await database1.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      assert(virtualEventLog.events.filter(x => x.event === 'miningLottery').length === 1, 'Expected 1 miningLottery');
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKN', '41.00000000', '50.00000000');
      await assertUserBalances('satoshi2', 'TKN', 0, '10.00000000');

      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = (await database1.getLatestBlockInfo());
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      assert(virtualEventLog.events.filter(x => x.event === 'miningLottery').length === 1, 'Expected only 1 miningLottery');
      lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKNB:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi2");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await assertUserBalances('satoshi', 'TKNB', 0, 0);
      await assertUserBalances('satoshi2', 'TKNB', '1.00000000', 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not create nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": 2}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "properties": [{"op": "ADD"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": {}}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": []}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [1,2,3,4,5]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "JAZZ"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "ADD", "name": "12345678901234567", "bad": 1}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "ADD", "name": "1234567890123456", "bad": 1}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5", "3"]}, "properties": [{"op": "ADD", "name": "1234567890123456"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["blah"]}, "properties": [{"op": "ADD", "name": "1234567890123456"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "100.1"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": "1"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": 1}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "none"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "NOTKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

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
      assertError(txs[10], 'nftTokenMiner invalid');
      assertError(txs[11], 'nftTokenMiner must have delegation enabled');
      assertError(txs[13], 'typeField must be a string');
      assertError(txs[14], 'typeField must be a string');
      assertError(txs[15], 'nftTokenMiner must have string type property');
      assertError(txs[17], 'nftTokenMiner must have string type property');
      assertError(txs[19], 'invalid nftTokenMiner typeMap');
      assertError(txs[20], 'invalid nftTokenMiner properties');
      assertError(txs[21], 'nftTokenMiner properties size must be between 1 and 4');
      assertError(txs[22], 'nftTokenMiner properties size must be between 1 and 4');
      assertError(txs[23], 'nftTokenMiner properties op should be ADD or MULTIPLY');
      assertError(txs[24], 'nftTokenMiner properties name should be a string of length <= 16');
      assertError(txs[25], 'nftTokenMiner properties field invalid');
      assertError(txs[26], 'nftTokenMiner typeConfig length mismatch');
      assertError(txs[27], 'nftTokenMiner typeConfig invalid');
      assertError(txs[28], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[29], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[30], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[31], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[32], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[33], 'nftTokenMiner properties burnChange symbol not found');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

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

      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');

      let eventLog = JSON.parse(res.transactions[12].logs);
      let createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN::TSTNFT');

      eventLog = JSON.parse(res.transactions[13].logs);
      createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN:TEST-TKN:TSTNFT');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should update nft mining power on delegation updates', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, {'account': 'mining', 'ownedBy': 'c', 'undelegateAt': 1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '3', {0: '2', 1: '1.5'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, {'account': 'mining', 'ownedBy': 'c'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '6.075', {0: '3', 1: '2.025'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '6.075'});

      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["4"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u', "undelegateAt":1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      transactions = [];
      transactions.push(new Transaction(12345678906, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678906,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNftInstance('satoshi2', 'TSTNFT', 4, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      transactions = [];
      transactions.push(new Transaction(12345678907, getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678907,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, {"account":"mining","ownedBy":"c","undelegateAt":1527984000000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      transactions = [];
      transactions.push(new Transaction(12345678908, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678908,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNftInstance('satoshi', 'TSTNFT', 1, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT2", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type2", "typeMap": "bad", "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": "bad", "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"car": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "100.1"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": "1"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": 1}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "none"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "NOTKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'cannot change nftTokenMiner token');
      assertError(txs[1], 'cannot change nftTokenMiner token');
      assertError(txs[2], 'cannot change nftTokenMiner token');
      assertError(txs[3], 'cannot change nftTokenMiner typeField');
      assertError(txs[4], 'invalid nftTokenMiner typeMap');
      assertError(txs[5], 'typeConfig types must be a superset of old typeConfig types');
      assertError(txs[6], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[7], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[8], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[9], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[10], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[11], 'nftTokenMiner properties burnChange symbol not found');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TEST.TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TEST.TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');
      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertTokenPool('TEST.TKN', 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await assertUserBalances('satoshi', 'TEST.TKN', '50.00000000', '50.00000000');

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1, nftTokenIndex: 0 });

      // allow mining power update to resume
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-100", "0.1"], "bull": ["50", "10"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: true, lastId: 0, tokenIndex: 1, nftTokenIndex: 0 });

      // allow mining power update to resume
      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '0', {0: '-50', 1: '1'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '0'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      // change ops
      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1", "1"], "bull": ["100", "1.5", "1"]}, "properties": [{"op": "MULTIPLY", "name": "power"}, {"op": "ADD", "name": "boost"}, {"op": "ADD", "name": "boost2"}]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '16000', {0: '5000', 1: '1.6', 2: '2'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '16000'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should handle nft delegation change during update', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0", "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: true, lastId: 2, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '1.125', {0: '2', 1: '0.5625'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '1.125'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others. make sure this op is processed
      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0', {0: '0', 1: '0.375'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
 
      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["5"]} ] }'));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      await assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '146.25', {0: '650', 1: '0.225'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '146.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update nft mining pool with burn', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let blockNumber = 12345678901;
      let transactions = [];
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TEST.TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TEST.TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: blockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertTokenPool('TEST.TKN', 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await assertUserBalances('satoshi', 'TEST.TKN', '50.00000000', '50.00000000');

      // allow to finish update
      blockNumber = await finishPowerUpdate(blockNumber + 1, 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      blockNumber += 1;
      transactions = [];
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": 0, "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": 0, "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": 0, "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "null", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "Infinity", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "NO", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "none", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "0.000000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi2', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "-0.491", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: blockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'invalid params');
      assertError(txs[2], 'invalid params');
      assertError(txs[3], 'invalid params');
      assertError(txs[4], 'invalid params');
      assertError(txs[5], 'invalid params');
      assertError(txs[6], 'you must use a custom_json signed with your active key');
      assertError(txs[7], 'pool id not found');
      assertError(txs[8], 'property not enabled for burn change');
      assertError(txs[9], 'type not found');
      assertError(txs[10], 'fee precision mismatch for amount 1e-10');
      assertError(txs[11], 'you must have enough tokens to cover the update fee of 1 TEST.TKN');
      assertError(txs[13], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[14], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update nft mining pool with burn', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let blockNumber = 12345678901;
      let transactions = [];
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TEST.TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TEST.TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: blockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertTokenPool('TEST.TKN', 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await assertUserBalances('satoshi', 'TEST.TKN', '50.00000000', '50.00000000');

      // allow to finish update
      blockNumber = await finishPowerUpdate(blockNumber + 1, 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      blockNumber += 1;
      transactions = [];
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: blockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      await assertUserBalances('satoshi', 'TEST.TKN', '49.00000000', '50.00000000');
  
      // allow to finish update
      blockNumber = await finishPowerUpdate(blockNumber + 1, 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '58.25', {0: '11', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '58.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      blockNumber += 1;
      transactions = [];
      transactions.push(new Transaction(blockNumber, getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "-5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: blockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
  
      await assertUserBalances('satoshi', 'TEST.TKN', '48.50000000', '50.00000000');

      // allow to finish update
      blockNumber = await finishPowerUpdate(blockNumber + 1, 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '54.5', {0: '6', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '54.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

});
