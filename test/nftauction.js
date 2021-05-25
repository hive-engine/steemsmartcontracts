/* eslint-disable */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-undef */
/* eslint-disable no-console */
/* eslint-disable func-names */

const { fork } = require('child_process');
const assert = require('assert');
const { MongoClient } = require('mongodb');

const { default: BigNumber } = require('bignumber.js');
const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');

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

const tknContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const nftauctionContractPayload = setupContractPayload('nftauction', './contracts/nftauction.js');

let txId = 1;
function getNextTxId() {
  txId += 1;
  return `TXID${txId.toString().padStart(8, '0')}`;
}

async function assertAuction(auctionId, reverse = false, bidIndex = null) {
  const res = await database1.findOne({
    contract: 'nftauction',
    table: 'auctions',
    query: {
      auctionId,
    },
  });

  if (!reverse) {
    assert.ok(res, `auction ${auctionId} not found.`);
    if (bidIndex) {
      assert.equal(res.currentLead, bidIndex, `expected currentLead to be ${bidIndex} instead got ${res.currentLead}`);
    }
  } else assert.ok(!res, `auction ${auctionId} is unexpected.`);
}

async function assertBalances(accounts, balances, symbol) {
  const res = await database1.find({
    contract: 'tokens',
    table: 'balances',
    query: {
      account: {
        $in: accounts,
      },
      symbol,
    },
  });

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    const {
      balance,
    } = res.find(el => el.account === account);
    const expectedBalance = balances[i];

    // console.log(expectedBalance, balance, account);
    const isEqual = BigNumber(expectedBalance).eq(balance);
    assert(isEqual, `expected @${account} balance ${expectedBalance} instead got ${balance}`);
  }
}

async function assertNFTInstances(account, ownedBy, nftIds, symbol) {
  const table = `${symbol}instances`;
  const res = await database1.find({
    contract: 'nft',
    table,
    query: {
      _id: {
        $in: nftIds,
      },
      account,
      ownedBy,
    },
  });

  assert.equal(res.length, nftIds.length, `${account} does not own instances`);
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

describe('NFT Auction Smart Contract', function () {
  this.timeout(20000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL,
        { useNewUrlParser: true, useUnifiedTopology: true });
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

  it('does not set market parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));

      // all these should fail
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "officialMarket": "mancermart" }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentFeePercent": 15000 }'));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFeePercent": 100.0001 }'));
      transactions.push(new Transaction(38145386, 'TXID1242', 'aggroed', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFeePercent": 100 }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify params table exists but no market specific params created
      let exists = await database1.tableExists({
        contract: 'nftauction',
        table: 'marketParams'
      });
      assert.equal(exists, true);

      let params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(params.length, 0);

      // verify failure conditions
      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      // console.log(JSON.parse(transactionsBlock1[7].logs).errors[0]);
      // console.log(JSON.parse(transactionsBlock1[8].logs).errors[0]);
      // console.log(JSON.parse(transactionsBlock1[9].logs).errors[0]);
      // console.log(JSON.parse(transactionsBlock1[10].logs).errors[0]);
      // console.log(JSON.parse(transactionsBlock1[11].logs).errors[0]);
      // console.log(JSON.parse(transactionsBlock1[12].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'nft symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid symbol');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sets market parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify params table exists but no market specific params created yet
      let exists = await database1.tableExists({
        contract: 'nftauction',
        table: 'marketParams'
      });
      assert.equal(exists, true);

      let params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(params.length, 0);

      // now set some market parameters
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1237', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "mancermart" }'));

      block = {
        refHiveBlockNumber: 38145387,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(2);
      // console.log(res.transactions[0].logs);
      params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      // console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentFeePercent, undefined);
      assert.equal(params[0].minFeePercent, undefined);

      // set more market parameters
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1238', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "agentFeePercent": 500 }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(3);
      // console.log(res.transactions[0].logs);
      params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      // console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentFeePercent, 500);
      assert.equal(params[0].minFeePercent, undefined);

      // set yet more market parameters
      transactions = [];
      transactions.push(new Transaction(38145389, 'TXID1239', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFeePercent": 100 }'));

      block = {
        refHiveBlockNumber: 38145389,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(4);
      // console.log(res.transactions[0].logs);
      params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      // console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "mancermart");
      assert.equal(params[0].agentFeePercent, 500);
      assert.equal(params[0].minFeePercent, 100);

      // set a combination of parameters
      transactions = [];
      transactions.push(new Transaction(38145390, 'TXID1240', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "minFeePercent": 50 }'));
      transactions.push(new Transaction(38145390, 'TXID1241', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "splinterlands", "agentFeePercent": 1200 }'));
      transactions.push(new Transaction(38145390, 'TXID1242', 'cryptomancer', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "peakmonsters", "agentFeePercent": 1100, "minFeePercent": 250 }'));

      block = {
        refHiveBlockNumber: 38145390,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(5);
      // console.log(res.transactions[0].logs);
      // console.log(res.transactions[1].logs);
      // console.log(res.transactions[2].logs);
      params = await database1.find({
        contract: 'nftauction',
        table: 'marketParams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      // console.log(params[0]);
      assert.equal(params.length, 1);
      assert.equal(params[0].symbol, "TEST");
      assert.equal(params[0].officialMarket, "peakmonsters");
      assert.equal(params[0].agentFeePercent, 1100);
      assert.equal(params[0].minFeePercent, 250);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not create an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": 1, "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": 0.1, "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": 100, "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": 0, "expiry": "2021-03-20T00:00:00" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": 1 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "PAY", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "-1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.00000000000005", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "-100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100.55555555555555", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2020-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2022-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["2", "3"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": "100" }`));
      transactions.push(new Transaction(38145390, getNextTxId(), 'ali-h', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "broker", "agentFeePercent": 1100, "minFeePercent": 250 }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));


      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[5], 'you must use a custom_json signed with your active key');
      assertError(txs[6], 'NFT symbol does not exist');
      assertError(txs[8], 'invalid params'); // invalid nfts
      assertError(txs[9], 'invalid params'); // invalid minBid
      assertError(txs[10], 'invalid params'); // invalid finalPrice
      assertError(txs[11], 'invalid params'); // invalid priceSymbol
      assertError(txs[12], 'invalid params'); // invalid expiry
      assertError(txs[13], 'priceSymbol does not exist');
      assertError(txs[14], 'invalid minBid'); // invalid quantity
      assertError(txs[15], 'invalid minBid'); // invalid precision
      assertError(txs[16], 'invalid finalPrice'); // invalid quantity
      assertError(txs[17], 'invalid finalPrice'); // invalid precision
      assertError(txs[18], 'invalid expiry');
      assertError(txs[19], 'expiry exceeds limit');
      assertError(txs[20], 'you must have enough tokens to cover the creation fee');
      assertError(txs[22], 'failed to trasfer NFTs to the contract');
      assertError(txs[23], 'invalid params'); // invalid fee
      assertError(txs[25], 'feePercent must be >= 250'); // invalid fee

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('nftauction', 'c', [1], 'TEST');
      await assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[7].logs);
      const auctionEvent = eventLog.events.find(x => x.event === 'create');
      assert.equal(auctionEvent.data.auctionId, txs[7].transactionId);

      await assertAuction(txs[7].transactionId);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));

      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": false, "auctionId": "AUCTION-TX", "bid": "19" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "--" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": 45, "bid": "12" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "545131", "bid": "15", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "-5", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.000000000000005", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.05", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "16.9", "marketAccount": "mart" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.5", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.3", "marketAccount": "mart" }'));

      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "15", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "15", "marketAccount": 520}'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[8], 'you must use a custom_json signed with your active key');
      assertError(txs[9], 'invalid params'); // invalid bid
      assertError(txs[10], 'invalid params'); // invalid auctionId
      assertError(txs[11], 'auction does not exist or has been expired');
      assertError(txs[12], 'invalid bid'); // negative value
      assertError(txs[13], 'invalid bid'); // precision
      assertError(txs[14], 'bid can not be less than 0.1');
      assertError(txs[15], 'insufficient balance for this bid');
      assertError(txs[18], 'bid must be greater than your previous bid');
      assertError(txs[19], 'auction seller can not bid');
      assertError(txs[20], 'invalid params'); // invalid marketAccount

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('bids multiple times in an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dev", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "19", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'dev', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "13", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "25", "marketAccount": "mart" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNoErrorInLastBlock();

      const eventLog = JSON.parse(res.transactions[7].logs);
      const auctionEvent = eventLog.events.find(x => x.event === 'create');
      assert.equal(auctionEvent.data.auctionId, txs[7].transactionId);

      await assertAuction(txs[7].transactionId);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update a previous bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dev", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "19", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'dev', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "13", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "25", "marketAccount": "mart" }'));

      // tries to update the bid with less quantity than before
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "15", "marketAccount": "mart" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertAuction('AUCTION-TX', false, 2);

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[14], 'bid must be greater than your previous bid');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates a previous bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dev", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "19", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'dev', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "13", "marketAccount": "mart" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "25", "marketAccount": "mart" }'));

      // tries to update the bid greater quantity than before
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "50", "marketAccount": "mart1" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // now that the bid is updated to be 5% more than the lead bid
      await assertAuction('AUCTION-TX', false, 0);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not cancel bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(12345678901, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-13T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));

      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": false, "auctionId": "AUCTION-TX" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": 452 }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX52" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'ali-h', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[10], 'you must use a custom_json signed with your active key');
      assertError(txs[11], 'invalid params'); // invalid auctionId
      assertError(txs[12], 'auction does not exist or has been expired');
      assertError(txs[13], 'you do not have a bid in this auction');

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'cryptomancer', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T23:56:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      txs = res.transactions;

      assertError(txs[0], 'can not cancel bid when auction is about to settle');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('cancels a bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"jhonny", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "15", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "21.5", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'jhonny', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "12.5", "marketAccount": "mart" }'));

      // cancels a bid < leadbid index
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertBalances(['dave'], ['100'], 'BEE');

      // makes sure lead bid's index is 1 (bidmaker)
      await assertAuction('AUCTION-TX', false, 1);

      await assertNoErrorInLastBlock();

      // new block
      transactions = [];
      // cancels a bid > leadbid index
      transactions.push(new Transaction(12345678902, getNextTxId(), 'jhonny', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertBalances(['jhonny'], ['100'], 'BEE');

      // makes sure lead bid's index is still 1 (bidmaker)
      await assertAuction('AUCTION-TX', false, 1);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('cancels a lead bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'cryptomancer', 'nftauction', 'cancelBid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertBalances(['cryptomancer'], ['100'], 'BEE');

      await assertNoErrorInLastBlock();

      // make sure now the lead bid index is 0 (dave)
      await assertAuction(txs[7].transactionId, false, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not cancel an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'cancel', '{ "isSignedWithActiveKey": false, "auctionId": "AUCTION-TX" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'cancel', '{ "isSignedWithActiveKey": true, "auctionId": 456 }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'cancel', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TXas" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'dave', 'nftauction', 'cancel', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[8], 'you must use a custom_json signed with your active key');
      assertError(txs[9], 'invalid params'); // invalid auctionId
      assertError(txs[10], 'auction does not exist or has been expired');
      assertError(txs[11], 'you must be the owner of the auction');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('cancels an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'cancel', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('ali-h', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker'], ['100', '100', '100'], 'BEE');

      await assertAuction('AUCTION-TX', true);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not settle an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 0 }`));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": false, "auctionId": "AUCTION-TX" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": 456 }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "account": 54 }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TXas" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'dave', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "account": "jojo" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      assertError(txs[8], 'you must use a custom_json signed with your active key');
      assertError(txs[9], 'invalid params'); // invalid auctionId
      assertError(txs[10], 'invalid params'); // invalid account
      assertError(txs[11], 'auction does not exist or has been expired');
      assertError(txs[12], 'you must be the owner of the auction');
      assertError(txs[13], 'there are no bids in the auction');
      assertError(txs[16], 'no bid from account found in the auction');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('settles an auction with final price hit', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "100", "marketAccount": "mart" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('bidmaker', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker', 'ali-h', "mart"], ['100', '100', '0', '99', "1"], 'BEE');

      await assertAuction('AUCTION-TX', true);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('settles an auction with lead bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('cryptomancer', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker', 'ali-h', 'mart'], ['90', '100', '100', '9.9', '0.1'], 'BEE');

      await assertAuction('AUCTION-TX', true);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('settles an auction with specific bid', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "account": "bidmaker" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('bidmaker', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker', 'ali-h', 'mart'], ['100', '100', '89.96', '9.9396', '0.1004'], 'BEE');

      await assertAuction('AUCTION-TX', true);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('settles an auction with lead bid and marketParams', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      const transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145390, getNextTxId(), 'ali-h', 'nftauction', 'setMarketParams', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "officialMarket": "broker", "agentFeePercent": 1100, "minFeePercent": 250 }'));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 300 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'nftauction', 'settle', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX" }'));

      const block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const txs = res.transactions;

      await assertNFTInstances('cryptomancer', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker', 'ali-h', 'mart', 'broker'], ['90', '100', '100', '9.7', '0.033', '0.267'], 'BEE');

      await assertAuction('AUCTION-TX', true);

      await assertNoErrorInLastBlock();

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not automatically settles an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T23:59:59',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      assert.ok(!res.virtualTransactions[0], 'unexpected virtual transaction');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('automatically settles an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dave", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'dave', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.049", "marketAccount": "mart" }'));
      transactions.push(new Transaction(12345678901, getNextTxId(), 'bidmaker', 'nftauction', 'bid', '{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "10.04", "marketAccount": "mart" }'));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      const settleEvent = virtualEventLog.events.find(x => x.event === 'settleAuction');

      assert.ok(settleEvent, 'expected to find a settle event');
      await assertNFTInstances('cryptomancer', 'u', [1], 'TEST');
      await assertBalances(['cryptomancer', 'dave', 'bidmaker', 'ali-h', 'mart'], ['90', '100', '100', '9.9', '0.1'], 'BEE');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not automatically expires an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T23:59:59',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      assert.ok(!res.virtualTransactions[0], 'unexpected virtual transaction');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('automatically expires an auction', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"2.01", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getLatestBlockInfo();
      const virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      const expireEvent = virtualEventLog.events.find(x => x.event === 'expireAuction');

      assert.ok(expireEvent, 'expected to find an expire event');
      await assertNFTInstances('ali-h', 'u', [1], 'TEST');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should only expire one auction per block', (done) => {
    new Promise(async (resolve) => {
      await loadPlugin(blockchain);
      database1 = new Database();

      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.01"} }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"3.02", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"Test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX-1', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));
      transactions.push(new Transaction(38145386, 'AUCTION-TX-2', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["2"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00", "feePercent": 100 }`));

      let block = {
        refHiveBlockNumber: 12345678901,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      await assertNoErrorInLastBlock();

      transactions = [];
      transactions.push(new Transaction(12345678902, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678902,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getLatestBlockInfo();
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let expireEvent = virtualEventLog.events.find(x => x.event === 'expireAuction');

      assert.ok(expireEvent, 'expected to find an expire event');
      await assertNFTInstances('ali-h', 'u', [1], 'TEST');
      await assertAuction('AUCTION-TX-1', true);

      // check that second auction must still be in the db
      await assertAuction('AUCTION-TX-2');

      transactions = [];
      transactions.push(new Transaction(12345678903, getNextTxId(), 'ali-h', 'extra', 'extra', '{}'));

      block = {
        refHiveBlockNumber: 12345678903,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getLatestBlockInfo();
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      expireEvent = virtualEventLog.events.find(x => x.event === 'expireAuction');

      assert.ok(expireEvent, 'expected to find an expire event');
      await assertNFTInstances('ali-h', 'u', [2], 'TEST');
      await assertAuction('AUCTION-TX-2', true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});