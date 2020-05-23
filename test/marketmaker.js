/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');


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

// prepare tokens contract for deployment
let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);
let base64ContractCode = Base64.encode(contractCode);

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

// prepare market contract for deployment
contractCode = fs.readFileSync('./contracts/market.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let mktContractPayload = {
  name: 'market',
  params: '',
  code: base64ContractCode,
};

// prepare market maker contract for deployment
contractCode = fs.readFileSync('./contracts/marketmaker.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
contractCode = contractCode.replace(/'\$\{CHAIN_TYPE\}\$'/g, 'HIVE');
base64ContractCode = Base64.encode(contractCode);

let mmContractPayload = {
  name: 'marketmaker',
  params: '',
  code: base64ContractCode,
};

// marketmaker 
describe('marketmaker', function() {
  this.timeout(200000);

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

  it('updates parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(mmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketmaker', 'updateParams', '{ "basicFee": "1", "basicSettingsFee": "2", "premiumFee": "3", "premiumBaseStake": "999", "stakePerMarket": "50", "basicDurationBlocks": "100", "basicCooldownBlocks": "150", "authorizedTicker": "theboss" }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[0].logs);

      // check if the params updated OK
      const params = await database1.findOne({
        contract: 'marketmaker',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(params.basicFee, '1');
      assert.equal(params.basicSettingsFee, '2');
      assert.equal(params.premiumFee, '3');
      assert.equal(params.premiumBaseStake, '999');
      assert.equal(params.stakePerMarket, '50');
      assert.equal(params.basicDurationBlocks, '100');
      assert.equal(params.basicCooldownBlocks, '150');
      assert.equal(params.authorizedTicker, 'theboss');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(mmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'aggroed', 'marketmaker', 'updateParams', '{ "basicFee": "1", "basicSettingsFee": "2", "premiumFee": "3", "premiumBaseStake": "999", "stakePerMarket": "50", "basicDurationBlocks": "100", "basicCooldownBlocks": "150", "authorizedTicker": "theboss" }'));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketmaker', 'updateParams', '{ "wrongKey": "oops"  }'));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketmaker', 'updateParams', '{ "premiumBaseStake": 666 }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // params should not have changed from their initial values
      const params = await database1.findOne({
        contract: 'marketmaker',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(params.basicFee, '100');
      assert.equal(params.basicSettingsFee, '1');
      assert.equal(params.premiumFee, '100');
      assert.equal(params.premiumBaseStake, '1000');
      assert.equal(params.stakePerMarket, '200');
      assert.equal(params.basicDurationBlocks, '403200');
      assert.equal(params.basicCooldownBlocks, '403200');
      assert.equal(params.authorizedTicker, 'enginemaker');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('registers a new user', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(mmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'marketmaker', 'updateParams', '{ "basicFee": "100", "basicSettingsFee": "1", "premiumFee": "100", "premiumBaseStake": "1000", "stakePerMarket": "200", "basicDurationBlocks": "100", "basicCooldownBlocks": "100", "authorizedTicker": "enginemaker" }'));
      transactions.push(new Transaction(38145386, 'TXID1232', 'cryptomancer', 'marketmaker', 'register', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the user was registered OK
      const user = await database1.findOne({
        contract: 'marketmaker',
        table: 'users',
        query: {}
      });

      console.log(user);

      assert.equal(user.account, 'cryptomancer');
      assert.equal(user.isPremium, false );
      assert.equal(user.isOnCooldown, false );
      assert.equal(user.isEnabled, true );
      assert.equal(user.markets, 0 );
      assert.equal(user.timeLimitBlocks, '100');
      assert.equal(user.lastTickBlock, 0);
      assert.equal(user.creationTimestamp, 1527811200000);
      assert.equal(user.creationBlock, 1);

      // verify failure conditions
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1233', 'cryptomancer', 'marketmaker', 'register', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1234', 'aggroed', 'marketmaker', 'register', '{ "isSignedWithActiveKey": false }'));

      block = {
        refHiveBlockNumber: 38145387,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block2 = await database1.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;

      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'user already registered');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'you must use a custom_json signed with your active key');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
