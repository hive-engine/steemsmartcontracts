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
const contractPayload = setupContractPayload('dao', './contracts/dao.js');

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

let txId = 1;
function getNextTxId() {
    txId++;
    return `TXID${txId.toString().padStart(8, "0")}`;
}

// distribution test suite
describe('dao tests', function () {
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

  it('should not create invalid DAO', (done) => {
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "0", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "8000", "maxAmountPerDay": "100", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "x", "proposalFee": { "method": "burn", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "free", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "100", "proposalFee": { "method": "issuer", "symbol": "TKN", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'spoofer', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1", "maxDays": "100", "maxAmountPerDay": "1.12345678999", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1.12345678999", "maxDays": "100", "maxAmountPerDay": "1222", "isSignedWithActiveKey": true }'));

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
      assertError(txs[12], 'must be issuer of baseToken');
      assertError(txs[13], 'voteToken must have staking enabled');
      assertError(txs[15], 'maxAmountPerDay precision mismatch');
      assertError(txs[16], 'voteThreshold precision mismatch');
      
      res = await database1.find({
        contract: 'dao',
        table: 'daos',
        query: { id: 'GLD:SLV' }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid DAO created');
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });

  });

  it('should create valid DAO', (done) => {
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));

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
        contract: 'dao',
        table: 'daos',
        query: {
          id: 'GLD:SLV'
        }
      });
      assert.ok(res, 'newly created DAO not found');
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
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'dao', 'updateParams', '{ "daoCreationFee": "2000", "daoTickHours": "1" }'));

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
        contract: 'dao',
        table: 'params',
        query: {},
      });
      assert.ok(res.daoCreationFee === '2000', 'daoCreationFee has not changed');
      assert.ok(res.daoTickHours === '1', 'daoTickHours has not changed');
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
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createDao', '{ "baseToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLVX", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'setDaoActive', '{ "daoId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fameMy moment of fameMy moment of fameMy moment of fameMy moment of fameMy moment of fameMy moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "0.1", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "champ", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10", "endDate": "2021-03-20", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2021-03-09T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-01T00:00:00.000Z", "endDate": "2021-03-05T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'donchate', 'dao', 'createProposal', '{ "daoId": "GLD:SLV", "title": "My moment of fame", "startDate": "2021-03-10T00:00:00.000Z", "endDate": "2025-03-12T00:00:00.000Z", "amountPerDay": "1000", "permlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));

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

      assertError(txs[8], 'you must use a transaction signed with your active key');
      assertError(txs[9], 'DAO does not exist');
      assertError(txs[10], 'DAO is not active');
      assertError(txs[12], 'invalid title: between 1 and 80 characters');
      assertError(txs[13], 'invalid permlink');
      assertError(txs[14], 'invalid amountPerDay: greater than 0');
      assertError(txs[15], 'invalid payout settings');
      assertError(txs[16], 'invalid datetime format: YYYY-MM-DDThh:mm:ss.sssZ');
      assertError(txs[17], 'start date greater than end date');
      assertError(txs[18], 'dates must be at least 1 day in the future');
      assertError(txs[19], 'date range exceeds DAO maxDays');
    
      res = await database1.find({
        contract: 'dao',
        table: 'daos',
        query: { id: 'GLD:SLV' }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid DAO created');
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
