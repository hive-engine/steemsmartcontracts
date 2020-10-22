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

// prepare nft contract for deployment
contractCode = fs.readFileSync('./contracts/nft.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let nftContractPayload = {
  name: 'nft',
  params: '',
  code: base64ContractCode,
};

// prepare packmanager contract for deployment
contractCode = fs.readFileSync('./contracts/packmanager.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let pmContractPayload = {
  name: 'packmanager',
  params: '',
  code: base64ContractCode,
};


// packmanager
describe('packmanager', function() {
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
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "999", "typeAddFee": "5" }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the params updated OK
      const params = await database1.findOne({
        contract: 'packmanager',
        table: 'params',
        query: {}
      });

      console.log(params);

      assert.equal(params.registerFee, '999');
      assert.equal(params.typeAddFee, '5');

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
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'aggroed', 'packmanager', 'updateParams', '{ "registerFee": "999", "typeAddFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "wrongKey": "123" }'));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": 666 }'));

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
        contract: 'packmanager',
        table: 'params',
        query: {}
      });

      assert.equal(params.registerFee, '1000');
      assert.equal(params.typeAddFee, '1');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('opens packs', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(38145386, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1060", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1239', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol":"PACK", "to":"cryptomancer", "quantity":"50", "isSignedWithActiveKey":true }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));

      // add some types
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 1, "rarity": 1, "team": 3, "name": "Tank", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 2, "team": 0, "name": "Destroyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 3, "team": 3, "name": "Submarine", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1245', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 3, "rarity": 4, "team": 0, "name": "B52 Bomber", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1246', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 3, "rarity": 5, "team": 3, "name": "Fighter Plane", "isSignedWithActiveKey": true }'));

      // test failure cases first
      transactions.push(new Transaction(38145386, 'TXID1247', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145386, 'TXID1248', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1249', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5.5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1250', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": -5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1251', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1252', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1253', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1254', 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1255', 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 21, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1256', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "50", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145386, 'TXID1257', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "50.123456789123456789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1258', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "BAD", "amount": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1259', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "999999", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(JSON.parse(transactionsBlock1[17].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[18].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[19].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[20].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[21].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[22].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[23].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[24].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[25].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[26].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[27].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[28].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[29].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'pack does not open this NFT');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'you must have enough packs');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'unable to open that many packs at once');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[28].logs).errors[0], 'NFT not under management');
      assert.equal(JSON.parse(transactionsBlock1[29].logs).errors[0], 'not enough tokens to deposit');

      // now verify packs can't be opened if the fee pool is too low
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1260', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.01", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1261', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.0499", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1262', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol":"PACK", "to":"aggroed", "quantity":"500", "isSignedWithActiveKey":true }'));
      transactions.push(new Transaction(38145387, 'TXID1263', 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));

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
      console.log(JSON.parse(transactionsBlock2[3].logs).errors[0]);
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'contract cannot afford issuance');

      // make sure pack balance did not change
      let balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: 'PACK',
          account: { $in: ['null', 'aggroed'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(balances.length, 1);
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[0].symbol, 'PACK');
      assert.equal(balances[0].balance, 500);

      // verify fee pool balance
      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: 'BEE',
          account: { $in: ['null', 'aggroed'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(balances.length, 2);
      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, 'BEE');
      assert.equal(balances[0].balance, '760.00000000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'BEE');
      assert.equal(balances[1].balance, '549.94010000');

      balances = await database1.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'BEE',
          account: { $in: ['packmanager'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(balances.length, 1);
      assert.equal(balances[0].account, 'packmanager');
      assert.equal(balances[0].symbol, 'BEE');
      assert.equal(balances[0].balance, '0.05990000');

      let managedNft = await database1.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {
          nft: 'WAR'
        },
        indexes: [{index: '_id', descending: false}],
      });
      assert.equal(managedNft.length, 1);
      assert.equal(managedNft[0].nft, 'WAR');
      assert.equal(managedNft[0].feePool, '0.05990000');

      // deposit more BEE to the fee pool and this time issue should work
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1264', 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.0001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1265', 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block3 = await database1.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;

      console.log(transactionsBlock3[0].logs);
      console.log(transactionsBlock3[1].logs);
      assert.equal(JSON.parse(transactionsBlock3[1].logs).errors, undefined);

      // check that all balances updated
      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: 'PACK',
          account: { $in: ['null', 'aggroed'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      console.log(balances);
      assert.equal(balances.length, 2);
      assert.equal(balances[1].account, 'null');
      assert.equal(balances[1].symbol, 'PACK');
      assert.equal(balances[1].balance, 5);
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[0].symbol, 'PACK');
      assert.equal(balances[0].balance, 495);

      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: 'BEE',
          account: { $in: ['null', 'aggroed'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      console.log(balances);
      assert.equal(balances.length, 2);
      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, 'BEE');
      assert.equal(balances[0].balance, '760.06000000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'BEE');
      assert.equal(balances[1].balance, '549.94000000');

      balances = await database1.find({
        contract: 'tokens',
        table: 'contractsBalances',
        query: {
          symbol: 'BEE',
          account: { $in: ['packmanager'] }
        },
        indexes: [{index: '_id', descending: false}],
      });
      console.log(balances);
      assert.equal(balances.length, 1);
      assert.equal(balances[0].account, 'packmanager');
      assert.equal(balances[0].symbol, 'BEE');
      assert.equal(balances[0].balance, 0);

      managedNft = await database1.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {
          nft: 'WAR'
        },
        indexes: [{index: '_id', descending: false}],
      });
      console.log(managedNft);
      assert.equal(managedNft.length, 1);
      assert.equal(managedNft[0].nft, 'WAR');
      assert.equal(managedNft[0].feePool, 0);

      const nftInstances = await database1.find({
        contract: 'nft',
        table: 'WARinstances',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(nftInstances);
      assert.equal(nftInstances.length, 15);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds and edits types', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(38145386, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1060", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "edition": 1, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));

      // add some types
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 1, "rarity": 1, "team": 3, "name": "Tank", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 2, "team": 0, "name": "Destroyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 3, "team": 3, "name": "Submarine", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1245', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 1, "category": 3, "rarity": 4, "team": 0, "name": "B52 Bomber", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1246', 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 1, "category": 3, "rarity": 5, "team": 3, "name": "Fighter Plane", "isSignedWithActiveKey": true }'));

      // do some updates
      transactions.push(new Transaction(38145386, 'TXID1247', 'cryptomancer', 'packmanager', 'updateType', '{ "nftSymbol": "WAR", "edition": 1, "typeId": 1, "name": "Japanese Zero Fighter", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1248', 'cryptomancer', 'packmanager', 'deleteType', '{ "nftSymbol": "WAR", "edition": 0, "typeId": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[12].logs);
      console.log(transactionsBlock1[13].logs);
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(transactionsBlock1[16].logs);
      console.log(transactionsBlock1[17].logs);
      console.log(transactionsBlock1[18].logs);

      // check if account balance updated OK
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['null', 'cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(balances);

      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 1260);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 0);

      // check that types were added
      const types = await database1.find({
        contract: 'packmanager',
        table: 'types',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(types);

      assert.equal(types[0].nft, 'WAR');
      assert.equal(types[0].edition, 0);
      assert.equal(types[0].typeId, 0);
      assert.equal(types[0].category, 1);
      assert.equal(types[0].rarity, 1);
      assert.equal(types[0].team, 3);
      assert.equal(types[0].name, 'Tank');
      assert.equal(types[1].nft, 'WAR');
      assert.equal(types[1].edition, 0);
      assert.equal(types[1].typeId, 2);
      assert.equal(types[1].category, 2);
      assert.equal(types[1].rarity, 3);
      assert.equal(types[1].team, 3);
      assert.equal(types[1].name, 'Submarine');
      assert.equal(types[2].nft, 'WAR');
      assert.equal(types[2].edition, 1);
      assert.equal(types[2].typeId, 0);
      assert.equal(types[2].category, 3);
      assert.equal(types[2].rarity, 4);
      assert.equal(types[2].team, 0);
      assert.equal(types[2].name, 'B52 Bomber');
      assert.equal(types[3].nft, 'WAR');
      assert.equal(types[3].edition, 1);
      assert.equal(types[3].typeId, 1);
      assert.equal(types[3].category, 3);
      assert.equal(types[3].rarity, 5);
      assert.equal(types[3].team, 3);
      assert.equal(types[3].name, 'Japanese Zero Fighter');

      // verify edition mappings
      const underManagement = await database1.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      console.log(underManagement[0].editionMapping);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(JSON.stringify(underManagement[0].editionMapping), '{"0":{"nextTypeId":3},"1":{"nextTypeId":2}}');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('registers new pack settings and updates settings', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(38145386, 'TXID1235', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 5, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[10].logs);

      // check if the pack was registered OK
      let settings = await database1.find({
        contract: 'packmanager',
        table: 'packs',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(settings);

      assert.equal(settings[0].account, 'cryptomancer');
      assert.equal(settings[0].symbol, 'PACK');
      assert.equal(settings[0].nft, 'WAR');
      assert.equal(settings[0].edition, 0);
      assert.equal(settings[0].cardsPerPack, 5);

      // check if account balance updated OK
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['null', 'cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(balances);

      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 750);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 0);

      // test failure cases
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1241', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145387, 'TXID1242', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1243', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1244', 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "BAD", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1245', 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "BAD", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1246', 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "edition": 0, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145387, 'TXID1247', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"500", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145387, 'TXID1248', 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 1, "cardsPerPack": 3, "isSignedWithActiveKey": true }'));

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

      console.log(JSON.parse(transactionsBlock2[0].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[1].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[2].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[3].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[4].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[7].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'you must have enough tokens to cover the registration fee');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'pack symbol must exist');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'NFT not under management');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'not authorized to register');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'pack already registered for WAR');

      // verify contract now manages the new NFT
      const underManagement = await database1.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      console.log(underManagement[0].editionMapping);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(JSON.stringify(underManagement[0].editionMapping), '{"0":{"nextTypeId":0}}');

      // update some settings
      transactions = [];
      // this should fail as edition 3 hasn't been registered
      transactions.push(new Transaction(38145388, 'TXID1249', 'cryptomancer', 'packmanager', 'updateSettings', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 3, "isSignedWithActiveKey": true }'));

      // this should succeed
      transactions.push(new Transaction(38145388, 'TXID1250', 'cryptomancer', 'packmanager', 'updateSettings', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "cardsPerPack": 7, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block3 = await database1.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;
      console.log(transactionsBlock3[0].logs);
      console.log(transactionsBlock3[1].logs);
      assert.equal(JSON.parse(transactionsBlock3[0].logs).errors[0], 'edition not registered');

      // check if the pack settings were updated OK
      settings = await database1.find({
        contract: 'packmanager',
        table: 'packs',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(settings);

      assert.equal(settings[0].account, 'cryptomancer');
      assert.equal(settings[0].symbol, 'PACK');
      assert.equal(settings[0].nft, 'WAR');
      assert.equal(settings[0].edition, 0);
      assert.equal(settings[0].cardsPerPack, 7);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates a collection NFT definition', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[5].logs);

      // check if the NFT was created OK
      const token = await database1.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'WAR' }
      });

      console.log(token);

      assert.equal(token.symbol, 'WAR');
      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.name, 'War Game Military Units');
      assert.equal(token.orgName, 'Wars R Us Inc');
      assert.equal(token.productName, 'War Game');
      assert.equal(token.metadata, '{"url":"https://mywargame.com"}');
      assert.equal(token.maxSupply, 0);
      assert.equal(token.supply, 0);
      assert.equal(JSON.stringify(token.authorizedIssuingAccounts), '[]');
      assert.equal(JSON.stringify(token.authorizedIssuingContracts), '["packmanager"]');
      assert.equal(token.circulatingSupply, 0);
      assert.equal(token.delegationEnabled, false);
      assert.equal(token.undelegationCooldown, 0);
      
      const properties = token.properties;
      console.log(properties);

      assert.equal(properties.edition.type, "number");
      assert.equal(properties.edition.isReadOnly, true);
      assert.equal(properties.foil.type, "number");
      assert.equal(properties.foil.isReadOnly, false);
      assert.equal(properties.type.type, "number");
      assert.equal(properties.type.isReadOnly, true);

      assert.equal(JSON.stringify(token.groupBy), '["edition","foil","type"]');

      // check if account balance updated OK
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['null', 'cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      console.log(balances);

      assert.equal(balances[0].account, 'null');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 50);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 50);

      // verify contract now manages the new NFT
      const underManagement = await database1.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(underManagement[0].categoryRO, false);
      assert.equal(underManagement[0].rarityRO, false);
      assert.equal(underManagement[0].teamRO, false);
      assert.equal(underManagement[0].nameRO, false);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not create a collection NFT definition', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"49", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 38145386,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // verify NFT was not created
      const token = await database1.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'WAR' }
      });

      assert.equal(token, null);

      const block1 = await database1.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;

      console.log(JSON.parse(transactionsBlock1[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[6].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must have enough tokens to cover the NFT creation');

      // test bad params
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145387, 'TXID1238', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "&&&^^^", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

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

      console.log(JSON.parse(transactionsBlock2[1].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[1].logs).errors[1]);

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[1], 'error creating NFT');

      // verify nothing subtracted from account balance
      const balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
          account: { $in: ['cryptomancer'] }
        },
        indexes: [{index: '_id', descending: false}],
      });

      assert.equal(balances[0].account, 'cryptomancer');
      assert.equal(balances[0].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[0].balance, 50);

      // verify you can't create a symbol twice
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1239', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"50", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145388, 'TXID1240', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1241', 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 38145388,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const block3 = await database1.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;
      
      console.log(JSON.parse(transactionsBlock3[2].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock3[2].logs).errors[0], 'symbol already exists');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
