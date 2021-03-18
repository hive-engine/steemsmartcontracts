/* eslint-disable */

const { fork } = require('child_process');
const assert = require('assert');
const { MongoClient } = require('mongodb');
const { Base64 } = require('js-base64');

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

async function assertAuction(auctionId, reverse = false) {
  const res = await database1.findOne({
    contract: 'nftauction',
    table: 'auctions',
    query: {
      auctionId,
    },
  });

  console.log(res);
  if (!reverse) assert.ok(res, `auction ${auctionId} not found.`);
  else assert.ok(!res, `auction ${auctionId} is unexpected.`);
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
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
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
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": 0, "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": 1 }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "PAY", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "-1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.00000000000005", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "-100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100.55555555555555", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2020-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2022-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"ali-h", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["2", "3"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));

      // transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to": "ali-h", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      // transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));

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
      transactions.push(new Transaction(38145386, getNextTxId(), 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));

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
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));

      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": false, "auctionId": "AUCTION-TX", "bid": "19" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "--" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": 45, "bid": "12" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "545131", "bid": "15" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "-5" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.000000000000005" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.05" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "16.9" }`));
      
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.5" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "0.3" }`));

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
      transactions.push(new Transaction(38145386, 'AUCTION-TX', 'ali-h', 'nftauction', 'create', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "minBid": "0.1", "finalPrice": "100", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "expiry": "2021-03-20T00:00:00" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"dev", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"bidmaker", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'cryptomancer', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "19" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'dev', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "13" }`));
      transactions.push(new Transaction(38145386, getNextTxId(), 'bidmaker', 'nftauction', 'bid', `{ "isSignedWithActiveKey": true, "auctionId": "AUCTION-TX", "bid": "25" }`));

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
});
