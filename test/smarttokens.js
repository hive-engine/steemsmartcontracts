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

function setupContractPayload(file) {
  let contractCode = fs.readFileSync(file);
  contractCode = contractCode.toString();
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);

  let base64ContractCode = Base64.encode(contractCode);

  return {
    name: 'tokens',
    params: '',
    code: base64ContractCode,
  };
}

const contractPayload = setupContractPayload('./contracts/tokens.js');
const oldContractPayload = setupContractPayload('./test/contracts/tokens_20200923.js');

async function assertUserBalanceAndStake(account, symbol, balance, stake) {
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
describe('smart tokens', function () {
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

  it('should enable delegation', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

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
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      );

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);
      assert.equal(token.delegationEnabled, true);
      assert.equal(token.undelegationCooldown, 7);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not enable delegation', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18250, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18250, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 0, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 18251, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

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

      assertError(txs[4], 'staking not enabled');
      assertError(txs[6], 'you must have enough tokens to cover  fees');
      assertError(txs[8], 'must be the issuer');
      assertError(txs[9], 'undelegationCooldown must be an integer between 1 and 18250');
      assertError(txs[10], 'undelegationCooldown must be an integer between 1 and 18250');
      assertError(txs[12], 'delegation already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should delegate tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik']
            },
            symbol: 'TKN'
          }
        });

      let balances = res;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999999");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000001");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      res = await database1.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      let delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        });

      balances = res;
      balances.sort((a, b) => a._id - b._id);

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999996");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000004");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000003");

      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].account, 'ned');
      assert.equal(balances[2].balance, "100");
      assert.equal(balances[2].stake, "0");
      assert.equal(balances[2].delegationsIn, "0.00000001");

      res = await database1.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000003');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not delegate tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "NKT", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.000000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ned', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "satoshi", "isSignedWithActiveKey": true }'));

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

      assertError(txs[5], 'invalid to');
      assertError(txs[6], 'symbol does not exist');
      assertError(txs[7], 'symbol precision mismatch');
      assertError(txs[8], 'delegation not enabled');
      assertError(txs[10], 'must delegate positive quantity');
      assertError(txs[11], 'balanceFrom does not exist');
      assertError(txs[12], 'overdrawn stake');
      assertError(txs[13], 'cannot delegate to yourself');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 100);
      assert.equal(balance.stake, 0);
      assert.equal(balance.delegationsOut, 0);
      assert.equal(balance.delegationsIn, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        });

      let balances = res;
      balances.sort((a, b) => a._id - b._id);

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999997");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000003");
      assert.equal(balances[0].pendingUndelegations, '0');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000002");

      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].account, 'ned');
      assert.equal(balances[2].balance, "0");
      assert.equal(balances[2].stake, "0");
      assert.equal(balances[2].delegationsIn, "0.00000001");

      res = await database1.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      let delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000002');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        });

      balances = res;
      balances.sort((a, b) => a._id - b._id);

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999997");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000002");
      assert.equal(balances[0].pendingUndelegations, '0.00000001');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      res = await database1.find({
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        });

      delegations = res;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      res = await database1.find({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let pendingUndelegations = res;

      assert.equal(pendingUndelegations[0].symbol, 'TKN');
      assert.equal(pendingUndelegations[0].account, 'satoshi');
      assert.equal(pendingUndelegations[0].quantity, '0.00000001');
      let blockDate = new Date('2018-06-01T00:00:01.000Z')
      assert.equal(pendingUndelegations[0].completeTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(pendingUndelegations[0].txID);


      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "NKT", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.000000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ned', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000004", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "satoshi", "isSignedWithActiveKey": true }'));
      
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

      assert.equal(JSON.parse(txs[5].logs).errors[0], 'invalid from');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'delegation not enabled');
      assert.equal(JSON.parse(txs[10].logs).errors[0], 'must undelegate positive quantity');
      assert.equal(JSON.parse(txs[11].logs).errors[0], 'balanceTo does not exist');
      assert.equal(JSON.parse(txs[12].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[16].logs).errors[0], 'balanceFrom does not exist');
      assert.equal(JSON.parse(txs[18].logs).errors[0], 'delegation does not exist');
      assert.equal(JSON.parse(txs[20].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[21].logs).errors[0], 'cannot undelegate from yourself');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should process the pending undelegations', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999997');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.delegationsIn, '0');
      assert.equal(balance.delegationsOut, '0.00000002');
      assert.equal(balance.pendingUndelegations, '0.00000000');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let undelegation = res;

      assert.equal(undelegation, null);

      res = await database1.getLatestBlockInfo();

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'undelegateDone');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should enable staking', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not enable staking', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 0, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 18251, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, false);
      assert.equal(token.unstakingCooldown, 1);

      res = await database1.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'you must have enough tokens to cover  fees');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 18250');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 18250');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not enable staking again', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 10, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      res = await database1.getLatestBlockInfo();
      let txs = res.transactions;
      assertError(txs[4], 'staking already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"vitalik", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik']
            },
            symbol: 'TKN'
          }
        });

      let balances = res;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, '99.99999997');
      assert.equal(balances[0].stake, '0.00000002');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, 0);
      assert.equal(balances[1].stake, '0.00000001');

      res = await database1.getLatestBlockInfo();

      let txs = res.transactions;
      
      assert.equal(JSON.parse(txs[0].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[0].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.account, 'satoshi');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.symbol, 'TKN');

      assert.equal(JSON.parse(txs[1].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[1].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.account, 'vitalik');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.symbol, 'TKN');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

      await assertTotalStaked('0.00000003');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not stake tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"ez", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "100.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await database1.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'must stake positive quantity');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(txs[9].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should start the unstake process', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      assert.equal(unstake.quantityLeft, '0.00000001');
      assert.equal(unstake.numberTransactionsLeft, 1);
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not start the unstake process', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await database1.getLatestBlockInfo();

      let txs = res.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must unstake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      await assertTotalStaked('0.00000001');
      
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      await assertTotalStaked(0);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID)
            
      const unstakeId = unstake.txID;

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000000');

      await assertTotalStaked('0.00000001');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should cancel a multi tx unstake', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 14, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000002", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999998");
      assert.equal(balance.stake, "0.00000002");

      await assertTotalStaked('0.00000002');
      
      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000002", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000002');

      await assertTotalStaked('0.00000001');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000002');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);
      
      const unstakeId = unstake.txID;

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000', 'pending unstake should be 0');

      await assertTotalStaked('0.00000002');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      await assertTotalStaked("0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');
      await assertTotalStaked(0);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      let blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);
        
      const unstakeId = unstake.txID;

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "NOTXID12378", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, getNextTxId(), 'harpagon', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000000');
      assert.equal(balance.pendingUnstake, '0.00000001');
      await assertTotalStaked(0);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should process the pending unstakes', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      await assertTotalStaked('0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      res = await database1.getLatestBlockInfo();

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      await assertTotalStaked(0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it.skip('should process thousands of pending unstakes', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.ok(unstake.txID);

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);

      res = await database1.getLatestBlockInfo();

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "1", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // generate thousands of unstakes
      console.log('start generating pending unstakes');
      for (let index = 10000; index < 11000; index++) {
        transactions = [];
        transactions.push(new Transaction(12345678901, `TXID${index}`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

        block = {
          refHiveBlockNumber: 12345678901 + index,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-07-14T00:02:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      transactions = [];
      transactions.push(new Transaction(12345698901, `TXID2000`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      console.log('done generating pending unstakes');

      block = {
        refHiveBlockNumber: 12345698901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00000000');
      assert.equal(balance.stake, '0.99998999');
      assert.equal(balance.pendingUnstake, '0.00001001');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345698902, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345698902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-21T00:02:00',
        transactions,
      };

      console.log('start processing pending unstakes');
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      console.log('done processing pending unstakes')
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00001000');
      assert.equal(balance.stake, '0.99998999');
      assert.equal(balance.pendingUnstake, '0.00000001');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should process the pending unstakes (with multi transactions)', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000008", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999992");
      assert.equal(balance.stake, "0.00000008");

      await assertTotalStaked('0.00000008');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000006", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999992');
      assert.equal(balance.stake, '0.00000006');
      assert.equal(balance.pendingUnstake, '0.00000006');

      await assertTotalStaked('0.00000006');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000006');
      assert.equal(unstake.numberTransactionsLeft, 3);
      let blockDate = new Date('2018-07-01T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.ok(unstake.txID);
        
      const unstakeId = unstake.txID;

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999994');
      assert.equal(balance.stake, '0.00000004');
      assert.equal(balance.pendingUnstake, '0.00000004');

      await assertTotalStaked('0.00000004');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000004');
      assert.equal(unstake.numberTransactionsLeft, 2);
      blockDate = new Date('2018-07-02T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, unstakeId);

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999996');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000002');

      await assertTotalStaked('0.00000002');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000002');
      assert.equal(unstake.numberTransactionsLeft, 1);
      blockDate = new Date('2018-07-03T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, unstakeId);

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678905, getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000');

      await assertTotalStaked('0.00000002');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      unstake = res;

      assert.equal(unstake, null);



      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not delegate tokens with unstaking', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "0.00000009", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000003", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

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
      assertError(txs[8], 'overdrawn stake');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      let balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999991');
      assert.equal(balance.stake, '0.00000006');
      assert.equal(balance.pendingUnstake, '0.00000007');
      assert.equal(balance.delegationsOut, '0.00000001');
      assert.equal(balance.delegationsIn, 0);

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      txs = res.transactions;
      assertError(txs[0], 'overdrawn stake');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        });

      balance = res;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999993');
      assert.equal(balance.stake, '0.00000003');
      assert.equal(balance.pendingUnstake, '0.00000005');
      assert.equal(balance.delegationsOut, '0.00000002');
      assert.equal(balance.delegationsIn, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should backfill stake balances for multi tx unstakes on contract update', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);
      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(oldContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 1, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.00000008", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "0.00000024", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000008", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "MTKN", "quantity": "0.00000008", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "MTKN", "quantity": "0.00000008", "to": "satoshi2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "MTKN", "quantity": "0.00000008", "to": "satoshi3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      console.log("Checking initial balances");
      await assertUserBalanceAndStake('satoshi', 'TKN', 0, '0.00000008');
      await assertUserBalanceAndStake('satoshi', 'MTKN', 0, '0.00000008');
      await assertUserBalanceAndStake('satoshi2', 'MTKN', 0, '0.00000008');
      await assertUserBalanceAndStake('satoshi3', 'MTKN', 0, '0.00000008');
      await assertTotalStaked('0.00000008', 'TKN');
      await assertTotalStaked('0.00000024', 'MTKN');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'satoshi', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      console.log("After first unstake ops");
      await assertUserBalanceAndStake('satoshi', 'TKN', 0, '0.00000001');
      await assertUserBalanceAndStake('satoshi', 'MTKN', 0, '0.00000001');
      await assertUserBalanceAndStake('satoshi2', 'MTKN', 0, '0.00000008');
      await assertUserBalanceAndStake('satoshi3', 'MTKN', 0, '0.00000008');
      await assertTotalStaked('0.00000008', 'TKN');
      await assertTotalStaked('0.00000024', 'MTKN');

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'satoshi2', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      console.log("After first unstake+1day, second unstake");
      await assertUserBalanceAndStake('satoshi', 'TKN', '0.00000007', '0.00000001');
      await assertUserBalanceAndStake('satoshi', 'MTKN', '0.00000002', '0.00000001');
      await assertUserBalanceAndStake('satoshi2', 'MTKN', 0, '0.00000001');
      await assertUserBalanceAndStake('satoshi3', 'MTKN', 0, '0.00000008');
      await assertTotalStaked('0.00000001', 'TKN');
      await assertTotalStaked('0.00000022', 'MTKN');

      transactions = [];
      transactions.push(new Transaction(12345678904, getNextTxId(), 'satoshi3', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000007", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 12345678904,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      console.log("After first unstake+2day, second unstake+1day, third unstake");
      await assertUserBalanceAndStake('satoshi', 'TKN', '0.00000007', '0.00000001');
      await assertUserBalanceAndStake('satoshi', 'MTKN', '0.00000004', '0.00000001');
      await assertUserBalanceAndStake('satoshi2', 'MTKN', '0.00000002', '0.00000001');
      await assertUserBalanceAndStake('satoshi3', 'MTKN', 0, '0.00000001');
      await assertTotalStaked('0.00000001', 'TKN');
      await assertTotalStaked('0.00000018', 'MTKN');

      await assertParams('fixMultiTxUnstakeBalance', undefined);

      transactions = [];
      transactions.push(new Transaction(12345678905, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));

      block = {
        refHiveBlockNumber: 12345678905,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };
      
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      console.log("After first unstake+3days, second unstake+2days, third unstake+1day, contract update");
      await assertParams('fixMultiTxUnstakeBalance', true);

      await assertUserBalanceAndStake('satoshi', 'TKN', '0.00000007', '0.00000001');
      await assertUserBalanceAndStake('satoshi', 'MTKN', '0.00000007', '0.00000001');
      await assertUserBalanceAndStake('satoshi2', 'MTKN', '0.00000004', '0.00000001');
      await assertUserBalanceAndStake('satoshi3', 'MTKN', '0.00000002', '0.00000004');
      await assertTotalStaked('0.00000001', 'TKN');
      await assertTotalStaked('0.00000006', 'MTKN');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

});
