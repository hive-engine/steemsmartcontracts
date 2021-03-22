/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { createVerify } = require('crypto');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');
const BigNumber = require('bignumber.js');
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
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const contractPayload = setupContractPayload('tokenfunds', './contracts/tokenfunds.js');

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

async function assertUserWeight(account, symbol, weight = 0) {
  const res = await database1.findOne({
    contract: 'tokenfunds',
    table: 'accounts',
    query: {
      account,
      'weights.symbol': symbol,
    }
  });
  assert.ok(res, `No weight for ${account}, ${symbol}`);
  const wIndex = res.weights.findIndex(x => x.symbol === symbol);
  assert.equal(res.weights[wIndex].weight, weight, `${account} has ${symbol} weight ${res.weights[wIndex].weight}, expected ${weight}`);
}

async function assertUserApproval(account, proposalId, present = true) {
  const res = await database1.findOne({
    contract: 'tokenfunds',
    table: 'approvals',
    query: {
      from: account,
      to: proposalId
    }
  });

  if (!present) {
    assert(!res, `proposalId found for ${account}, expected none.`);
    return;
  }
  assert.ok(res, `No proposalId for ${account}, ${proposalId}`);
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

async function assertWeightConsistency(proposalId, voteSymbol) {
  const prop = await database1.findOne({
    contract: 'tokenfunds',
    table: 'proposals',
    query: { _id: proposalId }
  }); 
  const app = await database1.find({
    contract: 'tokenfunds',
    table: 'approvals',
    query: { to: proposalId }
  });
  let appWeight = 0;
  for (let i = 0; i < app.length; i += 1) {
    const acct = await database1.findOne({
      contract: 'tokenfunds',
      table: 'accounts',
      query: { account: app[i].from }
    });
    const wIndex = acct.weights.findIndex(x => x.symbol === voteSymbol);
    if (wIndex !== -1) {
      appWeight = BigNumber(appWeight).plus(acct.weights[wIndex].weight).toNumber();
    }
  }
  assert.equal(appWeight, prop.approvalWeight, `prop.approvalWeight (${prop.approvalWeight}) doesn\'t equal total of account weights (${appWeight})`);
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

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// distribution test suite
describe('tokenfunds tests', function () {
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

  it('should not create invalid DTF', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "spoofer", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "0", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "8000", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "x", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "free", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "issuer", "symbol": "TKN", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'spoofer', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1.12345678999", "maxDays": "100", "maxAmountPerDay": "1222", "isSignedWithActiveKey": true }'));

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
      assertError(txs[7], 'invalid voteThreshold: greater than 0');
      assertError(txs[8], 'invalid maxDays: integer between 1 and 730');
      assertError(txs[9], 'invalid maxAmountPerDay: greater than 0');
      assertError(txs[10], 'invalid proposalFee');
      assertError(txs[11], 'invalid proposalFee token or precision');
      assertError(txs[12], 'must be issuer of payToken');
      assertError(txs[13], 'voteToken must have staking enabled');
      assertError(txs[15], 'maxAmountPerDay precision mismatch');
      assertError(txs[16], 'voteThreshold precision mismatch');

      res = await database1.find({
        contract: 'tokenfunds',
        table: 'funds',
        query: { id: 'GLD:SLV' }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid DTF created');      

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });      

      res = await database1.getLatestBlockInfo();
      txs = res.transactions;
      assertError(txs[1], 'DTF already exists');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create valid DTF', (done) => {
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));

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
      let res = await database1.findOne({
        contract: 'tokenfunds',
        table: 'funds',
        query: {
          id: 'GLD:SLV'
        }
      });
      assert.ok(res, 'newly created DTF not found');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update invalid DTF', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "spoofer", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "0", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "8000", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "x", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "free", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "issuer", "symbol": "TKN", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'spoofer', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateFund', '{ "fundId": "GLD:SLV", "voteThreshold": "1.12345678999", "maxDays": "100", "maxAmountPerDay": "1222", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block })

      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[8], 'you must use a transaction signed with your active key');
      assertError(txs[9], 'invalid voteThreshold: greater than 0');
      assertError(txs[10], 'invalid maxDays: integer between 1 and 730');
      assertError(txs[11], 'invalid maxAmountPerDay: greater than 0');
      assertError(txs[12], 'invalid proposalFee');
      assertError(txs[13], 'invalid proposalFee token or precision');
      assertError(txs[14], 'must be DTF creator');
      assertError(txs[15], 'maxAmountPerDay precision mismatch');
      assertError(txs[16], 'voteThreshold precision mismatch');
  
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
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokenfunds', 'updateParams', '{ "dtfCreationFee": "2000", "dtfTickHours": "1" }'));

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
        contract: 'tokenfunds',
        table: 'params',
        query: {},
      });
      assert.ok(res.dtfCreationFee === '2000', 'dtfCreationFee has not changed');
      assert.ok(res.dtfTickHours === '1', 'dtfTickHours has not changed');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not create invalid proposal', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "spoofer", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLVX", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "0.1", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10T00:00:00.000Z", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "champ", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-03-10", "endDate": "2023-03-20", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2023-05-20T00:00:00.000Z", "endDate": "2023-05-21T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-01T00:00:00.000Z", "endDate": "2021-03-05T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2022-05-20T00:00:00.000Z", "endDate": "2026-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-01T00:00:00.000Z", "endDate": "2021-03-05T00:00:00.000Z", "amountPerDay": "1000000000000000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block })

      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[8], 'you must use a transaction signed with your active key');
      assertError(txs[9], 'DTF does not exist');
      assertError(txs[10], 'DTF is not active');
      assertError(txs[12], 'invalid title: between 1 and 80 characters');
      assertError(txs[13], 'invalid authorperm: between 1 and 255 characters');
      assertError(txs[14], 'invalid amountPerDay: greater than 0');
      assertError(txs[15], 'invalid payout settings');
      assertError(txs[16], 'invalid datetime format: YYYY-MM-DDThh:mm:ss.sssZ');
      assertError(txs[17], 'dates must be at least 1 day apart');
      assertError(txs[18], 'startDate must be at least 1 day in the future');
      assertError(txs[19], 'date range exceeds DTF maxDays');
      assertError(txs[20], 'invalid amountPerDay: exceeds DTF maxAmountPerDay');
    
      res = await database1.find({
        contract: 'tokenfunds',
        table: 'proposals',
        query: { fundId: 'GLD:SLV' }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid proposal created');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create valid proposal', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "SLV", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "proposalFee": { "method": "issuer", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "SLV:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "SLV:GLD", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "SLV:GLD", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": 1 }, "name": "distribution" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      // let res = await database1.getLatestBlockInfo();
      // console.log(res);      
      await assertNoErrorInLastBlock();
      let resx = await database1.findOne({
        contract: 'tokenfunds',
        table: 'proposals',
        query: {
          _id: 1,
        }
      });
      assert.ok(resx, 'newly created proposal not found');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update invalid proposal', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "spoofer", "quantity": "5000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "x", "title": "A Big Community Project", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community ProjectA Big Community Project", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2023-03-12T00:00:00.000Z", "amountPerDay": "0.1", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2023-06-12T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2021-03-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "A Big Community Project", "endDate": "2021-03-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block })

      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[10], 'invalid id');
      assertError(txs[11], 'you must use a transaction signed with your active key');
      assertError(txs[12], 'invalid title: between 1 and 80 characters');
      assertError(txs[13], 'invalid authorperm: between 1 and 255 characters');
      assertError(txs[14], 'invalid amountPerDay: greater than 0 and cannot be increased');
      assertError(txs[15], 'date can only be reduced');
      assertError(txs[16], 'dates must be at least 1 day apart');
      assertError(txs[17], 'must be proposal creator');
    
      res = await database1.findOne({
        contract: 'tokenfunds',
        table: 'proposals',
        query: { _id: 1 }
      });
      // console.log(res);
      const original = { "_id": 1, "fundId": "GLD:SLV", "active": true, "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "creator": "organizer", "approvalWeight": 0 };
      assert.deepEqual(res, original, 'proposal has changed');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update valid proposal', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'updateProposal', '{ "id": "1", "title": "The Biggest Community Project", "endDate": "2021-04-29T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/testers", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      // let res = await database1.getLatestBlockInfo();
      // console.log(res);      
      await assertNoErrorInLastBlock();
      let resx = await database1.findOne({
        contract: 'tokenfunds',
        table: 'proposals',
        query: {
          _id: 1,
        }
      });
      const updated = { "_id": 1, "active": true, "fundId": "GLD:SLV", "title": "The Biggest Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-29T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/testers", "creator": "organizer", "approvalWeight": 0, "payout": { "type": "user", "name": "silverstein" } };
      assert.deepEqual(resx, updated, 'updates not found in proposal');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  

  it('should not run inactive proposals', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-03-16T00:00:00.000Z", "amountPerDay": "800", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-03-18T00:00:00.000Z", "amountPerDay": "800", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-17T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });      

      res = (await database1.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 0);

      // balance asserts
      await assertUserBalance('rambo', 'GLD');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  

  it('should run proposals and update approvals', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "SLV", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorperm": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Small Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "5", "authorperm": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter3', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "4", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      await assertNoErrorInLastBlock();

      // weight asserts
      await assertUserWeight('voter1', 'SLV', '1000.00000000');
      await assertUserWeight('voter2', 'SLV', '10000.00000000');
      await assertUserWeight('voter3', 'SLV', '100000.00000000');
      await assertUserWeight('voter4', 'GLD', '10000.00000000');
      await assertUserWeight('organizer', 'GLD', '0.00000000');
      await assertUserApproval('voter1', 2);
      await assertUserApproval('voter2', 2);
      await assertUserApproval('voter3', 2);
      await assertUserApproval('voter4', 3);
      await assertUserApproval('organizer', 3);
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');


      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });      

      res = (await database1.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await assertUserBalance('rambo', 'GLD', '500.00000000');
      await assertUserBalance('silverstein', 'GLD', '500.00000000');
      await assertContractBalance('distribution', 'GLD', '1000.00000000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should cap funds and proposals', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "SLV", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorperm": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'voter4', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Small Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "5", "authorperm": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter3', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "4", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let res = await database1.getLatestBlockInfo();
      // console.log(res);
      await assertNoErrorInLastBlock();

      // weight asserts
      await assertUserWeight('voter1', 'SLV', '1000.00000000');
      await assertUserWeight('voter2', 'SLV', '10000.00000000');
      await assertUserWeight('voter3', 'SLV', '100000.00000000');
      await assertUserWeight('voter4', 'GLD', '10000.00000000');
      await assertUserWeight('organizer', 'GLD', '0.00000000');
      await assertUserApproval('voter1', 2);
      await assertUserApproval('voter2', 2);
      await assertUserApproval('voter3', 2);
      await assertUserApproval('voter4', 3);
      await assertUserApproval('organizer', 3);
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });      

      res = (await database1.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await assertUserBalance('rambo', 'GLD', '500.00000000');
      await assertUserBalance('silverstein', 'GLD', '500.00000000');
      await assertContractBalance('distribution', 'GLD', '1000.00000000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should update stake weight on stake and delegation', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "staker", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "staker2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "delegator", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 1, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 1, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableDelegation', '{ "symbol": "GLD", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableDelegation', '{ "symbol": "SLV", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorperm": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      // let res = await database1.getLatestBlockInfo();
      // console.log(res);      
      await assertNoErrorInLastBlock();

      transactions = [];    
      transactions.push(new Transaction(12345678902, getNextTxId(), 'staker', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'staker2', 'tokens', 'stake', '{ "to": "staker2", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'staker2', 'tokenfunds', 'approveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV');
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

      transactions = [];    
      transactions.push(new Transaction(12345678903, getNextTxId(), 'staker', 'tokens', 'stake', '{ "to": "staker", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'delegator', 'tokens', 'stake', '{ "to": "delegator", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'delegator', 'tokens', 'delegate', '{ "to": "staker", "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 600);
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

      transactions = [];    
      transactions.push(new Transaction(12345678904, getNextTxId(), 'delegator', 'tokens', 'undelegate', '{ "from": "staker", "symbol": "SLV", "quantity": "50", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 550);
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

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

      transactions = [];    
      transactions.push(new Transaction(12345678906, getNextTxId(), 'staker', 'tokens', 'unstake', '{ "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678906, getNextTxId(), 'staker2', 'tokens', 'unstake', '{ "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678906,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 450);
      await assertUserWeight('staker2', 'SLV', 400);
      await assertWeightConsistency(1, 'SLV');

      transactions = [];    
      transactions.push(new Transaction(12345678907, getNextTxId(), 'staker', 'tokenfunds', 'disapproveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678907, getNextTxId(), 'staker2', 'tokenfunds', 'disapproveProposal', '{ "id": "1", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678907,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 450);
      await assertUserWeight('staker2', 'SLV', 400);
      await assertWeightConsistency(1, 'SLV');
      await assertUserApproval('staker', 1, false);
      await assertUserApproval('staker2', 1, false);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });  
  // END TESTS
});
