/* eslint-disable */
const assert = require('assert');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');
const { performance } = require('perf_hooks');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tknContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');

// prepare test contract for issuing & transferring NFT instances
const testSmartContractCode = `
  actions.createSSC = function (payload) {
    // Initialize the smart contract via the create action
  }

  actions.doTransfer = async function (payload) {
    await api.executeSmartContract('nft', 'transfer', payload);
  }

  actions.doDelegation = async function (payload) {
    await api.executeSmartContract('nft', 'delegate', payload);
  }

  actions.doUndelegation = async function (payload) {
    await api.executeSmartContract('nft', 'undelegate', payload);
  }

  actions.doBurn = async function (payload) {
    await api.executeSmartContract('nft', 'burn', payload);
  }

  actions.doIssuance = async function (payload) {
    await api.executeSmartContract('nft', 'issue', payload);
  }

  actions.doMultipleIssuance = async function (payload) {
    await api.executeSmartContract('nft', 'issueMultiple', payload);
  }

  actions.doSetProperties = async function (payload) {
    await api.executeSmartContract('nft', 'setProperties', payload);
  }
`;

base64ContractCode = Base64.encode(testSmartContractCode);

let testcontractPayload = {
  name: 'testcontract',
  params: '',
  code: base64ContractCode,
};

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

// nft
describe('nft', function() {
  this.timeout(20000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
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
      
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "nftIssuanceFee": {"DEC":"500","SCT":"0.75"}, "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "22.222" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the params updated OK
      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'params',
          query: {}
        });

      const params = res;

      assert.equal(params.nftCreationFee, '22.222');
      assert.equal(JSON.stringify(params.nftIssuanceFee), '{"DEC":"500","SCT":"0.75"}');
      assert.equal(params.dataPropertyCreationFee, '2');
      assert.equal(params.enableDelegationFee, '3');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": 0.5 , "nftIssuanceFee": 1, "dataPropertyCreationFee": 2, "enableDelegationFee": 3 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "hi" , "nftIssuanceFee": "bob", "dataPropertyCreationFee": "u", "enableDelegationFee": "rock" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "-0.5" , "nftIssuanceFee": "-1", "dataPropertyCreationFee": "-2", "enableDelegationFee": "-3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // params should not have changed from their initial values
      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'params',
          query: {}
        });

      const params = res;

      assert.equal(params.nftCreationFee, '100');
      assert.equal(JSON.stringify(params.nftIssuanceFee), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","PAL":"0.001"}`);
      assert.equal(params.dataPropertyCreationFee, '100');
      assert.equal(params.enableDelegationFee, '1000');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "orgName": "Mancer Inc", "productName": "My First Product", "symbol": "TEST", "authorizedIssuingAccounts": ["marc","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].orgName, '');
      assert.equal(tokens[0].productName, '');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, false);
      assert.equal(tokens[0].undelegationCooldown, 0);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].issuer, 'cryptomancer');
      assert.equal(tokens[1].name, 'test NFT 2');
      assert.equal(tokens[1].orgName, 'Mancer Inc');
      assert.equal(tokens[1].productName, 'My First Product');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 0);
      assert.equal(tokens[1].metadata, '{"url":""}');
      assert.equal(JSON.stringify(tokens[1].authorizedIssuingAccounts), '["marc","aggroed","harpagon"]');
      assert.equal(JSON.stringify(tokens[1].authorizedIssuingContracts), '["tokens","dice"]');
      assert.equal(tokens[1].circulatingSupply, 0);
      assert.equal(tokens[1].delegationEnabled, false);
      assert.equal(tokens[1].undelegationCooldown, 0);

      res = await fixture.database.findContract({
        name: 'nft',
      });

      let tables = res.tables;
      
      
      assert.equal('nft_TSTNFTinstances' in tables, true);
      assert.equal('nft_TESTinstances' in tables, true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not allow nft creation with invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "4", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":false, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"dsfds" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"tSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test@NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"-1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"99999999999999999999999999999999" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["myaccountdup","myaccountdup"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT2", "symbol":"TSTNFTTWO", "productName": "tooooooloooooooooonnnnnnnnnnnggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT2", "symbol":"TSTNFTTWO", "orgName": "tooooooloooooooooonnnnnnnnnnnggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must have enough tokens to cover the creation fees');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`);
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'symbol already exists');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('enables delegation', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "enableDelegationFee": "55" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"60", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, true);
      assert.equal(tokens[0].undelegationCooldown, 5);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","null"] }}
        });

      let balances = res;
      

      // check fees were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.00000000');
      assert.equal(balances[0].account, 'cryptomancer');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '60.00000000');
      assert.equal(balances[1].account, 'null');
      assert.equal(balances.length, 2);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not enable delegation', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "enableDelegationFee": "56" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"56", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"60", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": "dsads" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"INVALID", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must have enough tokens to cover fees');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid symbol');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'undelegationCooldown must be an integer between 1 and 18250');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'must be the issuer');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, false);
      assert.equal(tokens[0].undelegationCooldown, 0);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","null"] }}
        });

      let balances = res;
      

      // check fees were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '56.00000000');
      assert.equal(balances[0].account, 'cryptomancer');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '5.00000000');
      assert.equal(balances[1].account, 'null');
      assert.equal(balances.length, 2);

      // test that delegation cannot be enabled twice
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"56", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'delegation already enabled');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('delegates and undelegates tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // do some delegations
      // user -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // should not be able to delegate twice
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"marc", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // now start some undelegations
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"TEST", "ids":["1","1","1"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["300","301"]}, {"symbol":"TEST", "ids":["2","3","4"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo.account, 'testcontract');
      assert.equal(instances[2].delegatedTo.ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.undelegateAt > 0, true);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo.account, 'cryptomancer');
      assert.equal(instances[0].delegatedTo.ownedBy, 'u');
      assert.equal(instances[0].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo.account, 'contract2');
      assert.equal(instances[1].delegatedTo.ownedBy, 'c');
      assert.equal(instances[1].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.account, 'contract2');
      assert.equal(instances[2].delegatedTo.ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo.account, 'harpagon');
      assert.equal(instances[3].delegatedTo.ownedBy, 'u');
      assert.equal(instances[3].delegatedTo.undelegateAt > 0, true);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      let undelegations = res;
      

      assert.equal(undelegations.length, 3);
      assert.equal(undelegations[0].symbol, 'TSTNFT');
      assert.equal(JSON.stringify(undelegations[0].ids), '[3]');
      assert.equal(undelegations[0].completeTimestamp > 0, true);
      assert.equal(undelegations[1].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[1].ids), '[1]');
      assert.equal(undelegations[1].completeTimestamp > 0, true);
      assert.equal(undelegations[2].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[2].ids), '[2,3,4]');
      assert.equal(undelegations[2].completeTimestamp > 0, true);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction, just need to generate a new block
      // so we can check that pending undelegations are processed
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-04T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      // undelegations should still be pending as 5 days haven't passed yet
      undelegations = res;
      assert.equal(undelegations.length, 3);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // send whatever transaction, just need to generate a new block
      // so we can check that pending undelegations are processed
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'whatever2', 'whatever2', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-06T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      // undelegations should be finished now
      undelegations = res;
      
      assert.equal(undelegations.length, 0);

      res = await fixture.database.getBlockInfo(3);

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      
      
      
      

      assert.equal(logs.events[0].contract, 'nft');
      assert.equal(logs.events[0].event, 'undelegateDone');
      assert.equal(logs.events[0].data.symbol, 'TSTNFT');
      assert.equal(JSON.stringify(logs.events[0].data.ids), '[3]');
      assert.equal(logs.events[1].contract, 'nft');
      assert.equal(logs.events[1].event, 'undelegateDone');
      assert.equal(logs.events[1].data.symbol, 'TEST');
      assert.equal(JSON.stringify(logs.events[1].data.ids), '[1]');
      assert.equal(logs.events[2].contract, 'nft');
      assert.equal(logs.events[2].event, 'undelegateDone');
      assert.equal(logs.events[2].data.symbol, 'TEST');
      assert.equal(JSON.stringify(logs.events[2].data.ids), '[2,3,4]');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo, undefined);      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo, undefined);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo, undefined);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not undelegate tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 3", "symbol": "TESTER" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // do some delegations
      // user -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // validation errors
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TESTER", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": false, "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT"} ] }'));
      
      // is not the token owner
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["2"]} ] }'));

      // symbol does not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));

      // instances do not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      // instance is not being delegated
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'delegation not enabled for TESTER');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[28].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[29].logs).errors[0], 'invalid nft list');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].delegatedTo), '{"account":"testcontract","ownedBy":"c"}');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"contract2","ownedBy":"c"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].delegatedTo), '{"account":"contract2","ownedBy":"c"}');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].delegatedTo), '{"account":"harpagon","ownedBy":"u"}');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      let undelegations = res;

      assert.equal(undelegations.length, 0);

      // ensure we cannot undelegate something twice
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      undelegations = res;
      

      assert.equal(undelegations[0].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[0].ids), '[1]');
      assert.equal(undelegations[0].completeTimestamp > 0, true);
      assert.equal(undelegations.length, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not delegate tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      
      // symbol not enabled for delegation
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));

      // validation errors
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": false, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"reeeeaaalllllllyyyyyyylllllllloooooooooonnnnnnnngggggggg", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":" Aggroed ", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"null", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["-345"]}, {"symbol":"TEST", "ids":["1"]} ] }'));

      // is not the token owner
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'testcontract', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      // symbol does not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));
      // instances do not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'delegation not enabled for TEST');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'cannot delegate to self');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'cannot delegate to null');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'invalid nft list');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo, undefined);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo, undefined);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo, undefined);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('transfers tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // the actual transfers
      // user -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doTransfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doTransfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'cryptomancer');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'cryptomancer');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'contract2');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract2');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'harpagon');
      assert.equal(instances[3].ownedBy, 'u');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not transfer tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // validation errors
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": false, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"reeeeaaalllllllyyyyyyylllllllloooooooooonnnnnnnngggggggg", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":" Aggroed ", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"null", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["-345"]}, {"symbol":"TEST", "ids":["1"]} ] }'));

      // is not the token owner
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'testcontract', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      // symbol does not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));
      // instances do not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'cannot transfer to null; use burn action instead');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid nft list');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('burns tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}`);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      let balances = res;

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.89700000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '184.389');
      assert.equal(balances.length, 2);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '30.10300000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.611');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances.length, 2);

      // now burn the tokens
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1","2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      // here we try to spoof the calling contract name (which shouldn't be possible, it should just be ignored and reset to the correct name, in this case testcontract)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "callingContractInfo": {"name":"otherContract", "version":1}, "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST", "ids":["2","3","4","5","6","7","8","9","10"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 0);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 0);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'null');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'null');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'null');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), '{}');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'null');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'null');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'null');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), '{}');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'null');
      assert.equal(instances[3].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      balances = res;
      

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '25.00100000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.251');
      assert.equal(balances[2].account, 'cryptomancer');
      assert.equal(balances[2].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[2].balance, '167.89700000');
      assert.equal(balances[3].account, 'cryptomancer');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, '184.389');
      assert.equal(balances.length, 4);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;
      

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.00000000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '0.000');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances[2].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[2].balance, '5.10200000');
      assert.equal(balances[2].account, 'testcontract');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, '0.360');
      assert.equal(balances[3].account, 'testcontract');

      assert.equal(balances.length, 4);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not burn tokens', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      // fees: 2 BEE for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": false, "nfts": [ {"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": {"bad":"format"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST", "ids":["a","b","c"] } ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST"} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10"]},{"symbol":"TEST", "ids":["1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10"]} ] }'));
      
      // these transactions are properly formed but should fail due to not being called from the owning account, invalid symbol, and invalid instance ID
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'testcontract', 'doBurn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"BAD", "ids":["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["100"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'invalid nft list');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'invalid nft list');
      assert.equal(JSON.parse(transactionsBlock2[6].logs).errors[0], 'cannot operate on more than 50 NFT instances at once');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}`);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      let balances = res;

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.89700000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '184.389');
      assert.equal(balances.length, 2);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '30.10300000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.611');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances.length, 2);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('locks many nft instances within another nft instance', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"2000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"300" }'));
      for (let i = 37; i < 37+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(refBlockNumber, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"cryptomancer", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT instances were issued
      let instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 50);

      let t0 = performance.now();

      // issue a single token with 50 NFT instances (the maximum allowed) contained within it
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "lockNfts": [ {"symbol":"TSTNFT", "ids":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"]} ], "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let t1 = performance.now();
      

      const block2 = await fixture.database.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;
      

      // verify tokens are locked
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'nft' }
      });
      assert.equal(instances.length, 50);
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'cryptomancer' }
      });
      assert.equal(instances.length, 0);
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'aggroed' }
      });
      
      
      assert.equal(instances.length, 1);
      assert.equal(instances[0].lockedNfts[0].ids.length, 50);

      t0 = performance.now();

      // now burn the token to get all the locked NFT instances back
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["51"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      t1 = performance.now();
      

      const block3 = await fixture.database.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;
      

      // verify tokens are unlocked
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'nft' }
      });
      assert.equal(instances.length, 0);
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'aggroed' }
      });
      assert.equal(instances.length, 50);
      instances = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: { account: 'null' }
      });
      
      
      assert.equal(instances.length, 1);
      assert.equal(instances[0].lockedNfts.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('obeys container token burn restrictions', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"30" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["cryptomancer","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice","testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"cryptomancer", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"cryptomancer", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"cryptomancer", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"cryptomancer", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));

      // now issue NFT instances, locking some of the above tokens within them
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15" }, "lockNfts": [{"symbol":"TSTNFT", "ids":["1"]}] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15" }, "lockNfts": [{"symbol":"TEST", "ids":["1"]}] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15" }, "lockNfts": [{"symbol":"TSTNFT", "ids":["2"]}] }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15" }, "lockNfts": [{"symbol":"TEST", "ids":["2"]}] }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check NFT instances are OK
      let res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'aggroed'}
      });

      
      

      assert.equal(res.length, 6);
      assert.equal(res[0]._id, 3);
      assert.equal(res[1]._id, 4);
      assert.equal(res[2]._id, 5);
      assert.equal(res[2].lockedNfts.length, 1);
      assert.equal(res[3]._id, 6);
      assert.equal(res[3].lockedNfts.length, 1);
      assert.equal(res[4]._id, 7);
      assert.equal(res[4].lockedNfts.length, 1);
      assert.equal(res[5]._id, 8);
      assert.equal(res[5].lockedNfts.length, 1);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'aggroed'}
      });

      

      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 3);

      // scenario 1: can't burn more than one container instance at a time
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["5","6"]} ] }')); // token ID 6 should fail

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'aggroed'}
      });

      
      

      assert.equal(res.length, 6);
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].previousAccount, 'nft');
      assert.equal(res[0].previousOwnedBy, 'c');
      assert.equal(res[1]._id, 3);
      assert.equal(res[2]._id, 4);
      assert.equal(res[3]._id, 6);
      assert.equal(res[4]._id, 7);
      assert.equal(res[5]._id, 8);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'aggroed'}
      });

      

      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 3);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'null'}
      });

      

      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 5);
      assert.equal(res[0].previousAccount, 'aggroed');
      assert.equal(res[0].previousOwnedBy, 'u');
      assert.equal(res[0].lockedNfts.length, 0);

      // scenario 2: can't mix container + non-container instances (first token is non-container)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // token ID 6 should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["3"]}, {"symbol":"TSTNFT", "ids":["6","3"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'aggroed'}
      });

      
      

      assert.equal(res.length, 5);
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].previousAccount, 'nft');
      assert.equal(res[0].previousOwnedBy, 'c');
      assert.equal(res[1]._id, 4);
      assert.equal(res[2]._id, 6);
      assert.equal(res[3]._id, 7);
      assert.equal(res[4]._id, 8);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'aggroed'}
      });

      
      assert.equal(res.length, 0);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'null'}
      });

      

      assert.equal(res.length, 2);
      assert.equal(res[0]._id, 3);
      assert.equal(res[0].previousAccount, 'aggroed');
      assert.equal(res[0].previousOwnedBy, 'u');
      assert.equal(res[1]._id, 5);
      assert.equal(res[1].previousAccount, 'aggroed');
      assert.equal(res[1].previousOwnedBy, 'u');
      assert.equal(res[1].lockedNfts.length, 0);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'null'}
      });

      

      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 3);
      assert.equal(res[0].previousAccount, 'aggroed');
      assert.equal(res[0].previousOwnedBy, 'u');

      // scenario 3: can't mix container + non-container instances (first token is container)
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // token ID 4 should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["6","4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'aggroed'}
      });

      
      

      assert.equal(res.length, 4);
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].previousAccount, 'nft');
      assert.equal(res[0].previousOwnedBy, 'c');
      assert.equal(res[1]._id, 4);
      assert.equal(res[2]._id, 7);
      assert.equal(res[3]._id, 8);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'aggroed'}
      });

      
      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].previousAccount, 'nft');
      assert.equal(res[0].previousOwnedBy, 'c');

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {'account': 'null'}
      });

      

      assert.equal(res.length, 3);
      assert.equal(res[0]._id, 3);
      assert.equal(res[0].previousAccount, 'aggroed');
      assert.equal(res[0].previousOwnedBy, 'u');
      assert.equal(res[1]._id, 5);
      assert.equal(res[1].previousAccount, 'aggroed');
      assert.equal(res[1].previousOwnedBy, 'u');
      assert.equal(res[1].lockedNfts.length, 0);
      assert.equal(res[2]._id, 6);
      assert.equal(res[2].previousAccount, 'aggroed');
      assert.equal(res[2].previousOwnedBy, 'u');
      assert.equal(res[2].lockedNfts.length, 0);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {'account': 'null'}
      });

      

      assert.equal(res.length, 1);
      assert.equal(res[0]._id, 3);
      assert.equal(res[0].previousAccount, 'aggroed');
      assert.equal(res[0].previousOwnedBy, 'u');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('locks nft instances within other nft instances', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"30" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["cryptomancer","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice","testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"cryptomancer", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"cryptomancer", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"cryptomancer", "toType":"user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));

      // now issue another NFT instance, locking some of the above tokens within it
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15" }, "lockNfts": [{"symbol":"TSTNFT", "ids":["1","2","2","2","3"]}, {"symbol":"TEST", "ids":["3"]}, {"symbol":"INVALID", "ids":["1"]}] }`));

      // same thing but issuing from a contract this time
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "25", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thecryptodrive', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"marc", "toType":"user", "feeSymbol": "TKN", "lockNfts": [{"symbol":"TSTNFT", "ids":["2","3","4"]}, {"symbol":"TEST", "ids":["1","2"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {}
      });

      
      

      // check NFT instances are OK
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].account, 'nft');
      assert.equal(res[0].ownedBy, 'c');
      assert.equal(JSON.stringify(res[0].lockedTokens), '{}');
      assert.equal(res[0].previousAccount, 'cryptomancer');
      assert.equal(res[0].previousOwnedBy, 'u');
      assert.equal(res[1]._id, 2);
      assert.equal(res[1].account, 'nft');
      assert.equal(res[1].ownedBy, 'c');
      assert.equal(JSON.stringify(res[1].lockedTokens), '{}');
      assert.equal(res[1].previousAccount, 'cryptomancer');
      assert.equal(res[1].previousOwnedBy, 'u');
      assert.equal(res[2]._id, 3);
      assert.equal(res[2].account, 'nft');
      assert.equal(res[2].ownedBy, 'c');
      assert.equal(JSON.stringify(res[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"}`);
      assert.equal(res[2].previousAccount, 'testcontract');
      assert.equal(res[2].previousOwnedBy, 'c');
      assert.equal(res[3]._id, 4);
      assert.equal(res[3].account, 'aggroed');
      assert.equal(res[3].ownedBy, 'u');
      assert.equal(JSON.stringify(res[3].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15"}`);
      assert.equal(JSON.stringify(res[3].lockedNfts[0]), '{"symbol":"TSTNFT","ids":["1","2"]}');
      assert.equal(JSON.stringify(res[3].lockedNfts[1]), '{"symbol":"TEST","ids":["3"]}');
      assert.equal(res[3].lockedNfts.length, 2);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {}
      });

      
      

      assert.equal(res[0]._id, 1);
      assert.equal(res[0].account, 'nft');
      assert.equal(res[0].ownedBy, 'c');
      assert.equal(JSON.stringify(res[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(res[0].previousAccount, 'testcontract');
      assert.equal(res[0].previousOwnedBy, 'c');
      assert.equal(res[1]._id, 2);
      assert.equal(res[1].account, 'nft');
      assert.equal(res[1].ownedBy, 'c');
      assert.equal(JSON.stringify(res[1].lockedTokens), '{}');
      assert.equal(res[1].previousAccount, 'testcontract');
      assert.equal(res[1].previousOwnedBy, 'c');
      assert.equal(res[2]._id, 3);
      assert.equal(res[2].account, 'nft');
      assert.equal(res[2].ownedBy, 'c');
      assert.equal(JSON.stringify(res[3].lockedTokens), '{}');
      assert.equal(res[2].previousAccount, 'cryptomancer');
      assert.equal(res[2].previousOwnedBy, 'u');
      assert.equal(res[3]._id, 4);
      assert.equal(res[3].account, 'marc');
      assert.equal(res[3].ownedBy, 'u');
      assert.equal(JSON.stringify(res[3].lockedTokens), '{}');
      assert.equal(JSON.stringify(res[3].lockedNfts[0]), '{"symbol":"TSTNFT","ids":["3"]}');
      assert.equal(JSON.stringify(res[3].lockedNfts[1]), '{"symbol":"TEST","ids":["1","2"]}');
      assert.equal(res[3].lockedNfts.length, 2);

      // now burn a token and verify we get the locked NFT instances back
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TSTNFTinstances',
        query: {}
      });

      

      // make sure locked tokens have all been released
      assert.equal(res[0]._id, 1);
      assert.equal(res[0].account, 'aggroed');
      assert.equal(res[0].ownedBy, 'u');
      assert.equal(JSON.stringify(res[0].lockedTokens), '{}');
      assert.equal(res[0].previousAccount, 'nft');
      assert.equal(res[0].previousOwnedBy, 'c');
      assert.equal(res[1]._id, 2);
      assert.equal(res[1].account, 'aggroed');
      assert.equal(res[1].ownedBy, 'u');
      assert.equal(JSON.stringify(res[1].lockedTokens), '{}');
      assert.equal(res[1].previousAccount, 'nft');
      assert.equal(res[1].previousOwnedBy, 'c');
      assert.equal(res[3]._id, 4);
      assert.equal(res[3].account, 'null');
      assert.equal(res[3].ownedBy, 'u');
      assert.equal(JSON.stringify(res[3].lockedTokens), '{}');
      assert.equal(JSON.stringify(res[3].lockedNfts), '[]');
      assert.equal(res[3].previousAccount, 'aggroed');
      assert.equal(res[3].previousOwnedBy, 'u');
      assert.equal(res[3].lockedNfts.length, 0);

      res = await fixture.database.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: {}
      });

      

      assert.equal(res[2]._id, 3);
      assert.equal(res[2].account, 'aggroed');
      assert.equal(res[2].ownedBy, 'u');
      assert.equal(JSON.stringify(res[2].lockedTokens), '{}');
      assert.equal(res[2].previousAccount, 'nft');
      assert.equal(res[2].previousOwnedBy, 'c');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('issues nft instances', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.903", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["cryptomancer","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice","testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"contract1", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"dice", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"contract2", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      
      // issue from contract to contract on behalf of a user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'testcontract', 'doIssuance', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"contract3", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"} }`));

      // issue from contract to contract
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.5", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.5", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "4.4", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'testcontract', 'doIssuance', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"} }`));

      // issue from contract to user
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.8", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.8", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'thecryptodrive', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"null", "toType":"user", "feeSymbol": "TKN" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      const tokens = res;
      

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].issuer, 'cryptomancer');
      assert.equal(tokens[1].name, 'test NFT 2');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 5);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract1');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"}`);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'dice');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'contract2');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract3');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'contract4');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"}`);
      assert.equal(instances[4]._id, 5);
      assert.equal(instances[4].account, 'null');
      assert.equal(instances[4].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[4].lockedTokens), '{}');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'balances',
          query: { account: 'cryptomancer' }
        });

      let balances = res;
      

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.10000000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '0.000');

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;
      

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '21.50000000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.003');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, '0.000');
      assert.equal(balances[2].account, 'testcontract');
      assert.equal(balances[3].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[3].balance, '0.00000000');
      assert.equal(balances[3].account, 'testcontract');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not issue nft instances', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.403", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      
      // invalid params
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fromType":"contract" }`));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fromType":"dddd" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "toType":"dddd" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "INVALID" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN", "lockTokens":"bad format" }'));

      // invalid to
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"a", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"toooooooolllllllllooooooooonnnnnnnggggggggg", "feeSymbol": "TKN" }'));

      // symbol does not exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "BADSYMBOL", "to":"aggroed", "feeSymbol": "TKN" }'));

      // not allowed to issue tokens
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "TKN" }'));

      // max supply limit reached
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"contract1", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"dice", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));

      // not enough balance for issuance fees
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.3", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.1", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.3"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "contracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.2"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "TKN" }'));

      // invalid locked token basket
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.001"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"100"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"AAA":"100"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"0.1","BBB":"10"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": [1,2,3] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"0.0001"} }'));

      // invalid locked NFT list - can't lock more than 50 at once
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockNfts": [{"symbol":"TSTNFT", "ids":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'max supply limit reached');
      assert.equal(JSON.parse(transactionsBlock1[30].logs).errors[0], 'you must have enough tokens to cover the issuance fees');
      assert.equal(JSON.parse(transactionsBlock1[32].logs).errors[0], 'you must have enough tokens to cover the issuance fees');
      assert.equal(JSON.parse(transactionsBlock1[34].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[35].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[36].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[37].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[38].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[39].logs).errors[0], 'cannot operate on more than 50 NFT instances at once');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('issues multiple nft instances', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      const lockTokens = {};
      lockTokens[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "5.75";

      const lockTokens2 = {};
      lockTokens2[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "10";

      let instances1 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"harpagon", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },
        { symbol: "TSTNFT", to:"cryptomancer", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"color":"red","frozen":true} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
      ];

      let instances2 = [
        { fromType: "user", symbol: "TSTNFT", to:"contract1", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },   // won't issue this one because caller not authorized
        { fromType: "contract", symbol: "TSTNFT", to:"dice", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },
        { fromType: "contract", symbol: "TSTNFT", to:"tokens", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"color":"red","frozen":true} },
        { fromType: "contract", symbol: "TSTNFT", to:"market", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens:{}, properties:{} },
      ];

      let instances3 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockNfts: [ {symbol:"TSTNFT", ids:["3","2"]} ] },    // won't lock token ID 2 because owner is harpagon
      ];

      

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'testcontract', 'doMultipleIssuance', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances2)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances3)} }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"level":0}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'harpagon');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5.75"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'nft');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].properties), '{"color":"red","frozen":true}');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[2].previousAccount, 'cryptomancer');
      assert.equal(instances[2].previousOwnedBy, 'u');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'marc');
      assert.equal(instances[3].ownedBy, 'u');

      assert.equal(instances[4]._id, 5);
      assert.equal(instances[4].account, 'dice');
      assert.equal(instances[4].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[4].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5.75"}`);
      assert.equal(instances[5]._id, 6);
      assert.equal(instances[5].account, 'tokens');
      assert.equal(instances[5].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[5].properties), '{"color":"red","frozen":true}');
      assert.equal(JSON.stringify(instances[5].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[6]._id, 7);
      assert.equal(instances[6].account, 'market');
      assert.equal(instances[6].ownedBy, 'c');

      assert.equal(instances[7]._id, 8);
      assert.equal(instances[7].account, 'aggroed');
      assert.equal(instances[7].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[7].properties), '{}');
      assert.equal(JSON.stringify(instances[7].lockedTokens), '{}');
      assert.equal(JSON.stringify(instances[7].lockedNfts[0]), '{"symbol":"TSTNFT","ids":["3"]}');

      res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'not allowed to issue tokens');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not issue multiple nft instances', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      // can't issue this many at once
      let instances1 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
      ];

      const lockTokens = {};
      lockTokens[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "5.75";

      const lockTokens2 = {};
      lockTokens2[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "10";

      let instances2 = [
        { fromType: "user", symbol: "TSTNFT", to:"contract1", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },   // won't issue this one because caller not authorized
        { fromType: "contract", symbol: "BAD", to:"dice", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },      // bad symbol
        { fromType: "contract", symbol: "TSTNFT", to:"tokens", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"invalid":"red","frozen":true} },   // data property doesn't exist
        { fromType: "contract", symbol: "TSTNFT", to:"market", toType: "contract", lockTokens:{}, properties:{} },     // missing fee symbol, invalid params
      ];

      // can't issue more than one container token at a time
      let instances3 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0}, lockNfts:[ {symbol:"TSTNFT", ids:["1","2"]} ] },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockNfts:[ {symbol:"TSTNFT", ids:["1","2"]} ] },
      ];

      // can't mix container and non-container tokens
      let instances4 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockNfts:[ {symbol:"TSTNFT", ids:["1","2"]} ] },
      ];

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": false, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', '{ "isSignedWithActiveKey": true, "instances": {"bad":"formatting"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', '{ "isSignedWithActiveKey": true, "instances": [1,2,3,4,5] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'testcontract', 'doMultipleIssuance', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances2)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances3)} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances4)} }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[1], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[2], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[3], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[4], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'cannot issue more than 10 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[1], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[2], 'data property must exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[3], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot issue more than 1 container NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'cannot issue a mix of container and non-container NFT instances simultaneously');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      
      assert.equal(instances.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sets the market group by list', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '["level","isFood"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not set the market group by list', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      
      // all these should fail
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": {"level":"isFood"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"BAD", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood","color","frozen","badproperty"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood","level"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","Level"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'cannot set more data properties than NFT has');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'list cannot contain duplicates');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'data property must exist');

      res = await fixture.database.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '[]');

      // make sure the list cannot be set more than once
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["color","frozen"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'list is already set');

      res = await fixture.database.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      tokens = res;

      // make sure list didn't change once set
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '["level","isFood"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('adds data properties', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`,
            account: "cryptomancer"
          }
        });

      
      assert.equal(res.balance, "10.00000000");

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not add data properties', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":23 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":1234, "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":[], "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":" isFood ", "type":"boolean" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"thisnameistootootootootootoolooooooooooooooooong", "type":"boolean" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"invalidtype", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'you must have enough tokens to cover the creation fees');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid type: must be number, string, or boolean');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'cannot add the same property twice');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'must be the issuer');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      let properties = tokens[0].properties;
      assert.equal(Object.keys(properties).length, 3)

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sets data properties', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"7.5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["aggroed","cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"level":0} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"level":1,"color":"yellow"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":["testcontract"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","level":"2"}},{"id":"3", "properties": {"color":"black"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"frozen":true}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"frozen":false}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"level":"999"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {}},{"id":"2", "properties": {}},{"id":"3", "properties": {}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [{"id":"1", "properties": {}},{"id":"3", "properties": {"level":3,"level":3,"level":3}}] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [{"id":"3", "properties": {"id":"NFT-XYZ-123"}}] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [{"id":"3", "properties": {"id":"NFT-ABC-666"}}] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"level":2,"color":"red"}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'marc');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].properties), '{"frozen":true}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].properties), '{"level":3,"color":"black","id":"NFT-XYZ-123"}');
      assert.equal(instances.length, 3);

      res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot edit read-only properties');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'cannot edit read-only properties');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not set data properties', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5.4", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["aggroed","cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"color":"blue", "level":"5", "frozen": true} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": { "symbol":"TSTNFT" } }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "fromType":"user", "nfts": [ 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101 ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "fromType":"contract", "nfts": [ 1, 2, 3 ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"BAD", "nfts": [ {"id":"1", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","frozen":false}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"color":"green", "level":2, "frozen": false} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","color1":"red","color2":"red","color3":"red"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"&*#()*$":"red"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"vehicle":"car"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"color":3.14159}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"yellow","level":"3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679"}} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ { "badkey": "badvalue" } ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'cannot set properties on more than 50 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'nft instance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot edit read-only properties');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'cannot set more data properties than NFT has');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid data property name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'data property must exist');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'data property type mismatch: expected string but got number for property color');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'string property max length is 100 characters');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid data properties');

      res = await fixture.database.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"color":"red","level":5,"frozen":true}');
      assert.equal(instances.length, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates data property definitions', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"string" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "newName":"age", "type":"number", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["Color","age"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      
      
      
      

      res = await fixture.database.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let properties = res[0].properties;
      
      

      assert.equal(Object.keys(properties).length, 4);
      assert.equal(properties.Color.type, "string");
      assert.equal(properties.Color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.Color.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.Color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '[]');
      assert.equal(properties.age.type, "number");
      assert.equal(properties.age.isReadOnly, false);
      assert.equal(JSON.stringify(properties.age.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.age.authorizedEditingContracts), '[]');
      assert.equal(properties.isFood.type, "string");
      assert.equal(properties.isFood.isReadOnly, true);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update data property definitions', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "name":"color", "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"no spaces allowed", "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"no spaces allowed" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":1234, "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"notavalidtype" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "isReadOnly":1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"INVALID", "name":"color", "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"Color", "newName":"color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'marc', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"Color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"color" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"frozen" }'));

      // groupBy test
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "newName":"theFood" }'));

      // make sure no changes can be made after issuing tokens
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updatePropertyDefinition', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "newName":"Color" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid new name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'invalid type: must be number, string, or boolean');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'invalid isReadOnly: must be true or false');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'property must exist');
      assert.equal(JSON.parse(transactionsBlock2[8].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[9].logs).errors[0], 'new name must be different from old name');
      assert.equal(JSON.parse(transactionsBlock2[10].logs).errors[0], 'there is already a data property with the given new name');
      assert.equal(JSON.parse(transactionsBlock2[12].logs).errors[0], 'cannot change data property name; property is part of groupBy');
      assert.equal(JSON.parse(transactionsBlock2[14].logs).errors[0], 'cannot change data property definition; tokens already issued');

      res = await fixture.database.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let properties = res[0].properties;
      

      assert.equal(Object.keys(properties).length, 4);
      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.color.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '[]');
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingContracts), '[]');
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sets data property permissions', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "contracts":["  tokens","market   "] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":["contract1","  contract2  ","contract3"], "accounts":["Harpagon"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "contracts":[], "accounts":[] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.color.authorizedEditingAccounts), '["aggroed","cryptomancer","marc"]');
      assert.equal(JSON.stringify(properties.color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '["tokens","market"]');
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingAccounts), '["harpagon"]');
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingContracts), '["contract1","contract2","contract3"]');
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '[]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '[]');

      res = await fixture.database.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`,
            account: "cryptomancer"
          }
        });

      
      assert.equal(res.balance, "10.00000000");

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not set data property permissions', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "contracts":{ "market":true } }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "accounts": 3 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"is Food", "contracts":[], "accounts":[] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "contracts":[], "accounts":["acc1","acc2","acc3","acc4","acc5","acc6","acc7","acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "accounts":[], "contracts":["acc1","acc2","acc3","acc4","acc5","acc6","acc7","acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "accounts":[1,2,3] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":[true,"contract1"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"rarity", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["cryptomancer","cryptomancer","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "contracts":["contract1","tokens","market","tokens"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.color.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '[]');
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingContracts), '[]');
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'cannot have more than 10 authorized accounts');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'cannot have more than 10 authorized contracts');
      assert.equal(JSON.parse(transactionsBlock2[6].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock2[8].logs).errors[0], 'property must exist');
      assert.equal(JSON.parse(transactionsBlock2[9].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[10].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock2[11].logs).errors[0], 'cannot add the same contract twice');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('adds to the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('adds to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not add to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc1","acc2","acc3","acc4","acc5","acc6","acc7"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [1, 2, 3] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": {"account": "aggroed"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["dup1","dup2"," DUP2","dup3"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["a","aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["tooooooooolooooooooong","aggroed"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock = block1.transactions;
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock[7].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock[8].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock[10].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock[11].logs).errors[0], 'cannot have more than 10 authorized issuing accounts');
      assert.equal(JSON.parse(transactionsBlock[12].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock[13].logs).errors[0], 'invalid account list');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not add to the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["acc1","acc2","acc3","acc4","acc5","acc6","acc7"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens","market"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [1, 2, 3] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": {"contract": "tokens"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["dup1","dup2"," dup2","dup3"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["a","tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tooooooooolooooooooooooooooooooooooooooooooooooooooooong","tokens"] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock = block1.transactions;
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock[7].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock[8].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock[10].logs).errors[0], 'cannot add the same contract twice');
      assert.equal(JSON.parse(transactionsBlock[11].logs).errors[0], 'cannot have more than 10 authorized issuing contracts');
      assert.equal(JSON.parse(transactionsBlock[12].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock[13].logs).errors[0], 'invalid contract list');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes from the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["missingaccount","satoshi","satoshi"," Harpagon "] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","marc"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["marc","nothere","cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["marc","nothere","cryptomancer"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '[]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('removes from the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["dice"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["missingcontract","contract1","contract1"," tokens "] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["market","contract2"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract2","nothere","market"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract2","nothere","market"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '[]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not remove from the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": { "aggroed": true } }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed", 2, 3 ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not remove from the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": { "tokens": true } }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens", 2, 3 ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates the product name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "productName":"Pet Rocks", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "Crypto Rocks" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, '');
      assert.equal(token.productName, 'Crypto Rocks');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update the product name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "productName":"Pet Rocks", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "name": "Crypto Rocks" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "Crypto Rocks" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "&%^#" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, '');
      assert.equal(token.productName, 'Pet Rocks');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates the organization name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "orgName":"Evil Inc", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "Angels R Us" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, 'Angels R Us');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update the organization name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "orgName":"Evil Inc", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "name": "Angels R Us" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "Angels R Us" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "&%^#" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, 'Evil Inc');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'Cool Test NFT');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "&%^#" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(token.name, 'test NFT');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      
      
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      assert.equal(JSON.parse(token.metadata).url, 'http://mynft.com');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'https://url.token.com');
      assert.equal(metadata.image, 'https://image.token.com');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not update the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'http://mynft.com');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('transfers the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      token = res;
      

      assert.equal(token.issuer, 'satoshi');
      assert.equal(token.symbol, 'TSTNFT');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not transfer the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "s", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      token = res;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      res = await fixture.database.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid to');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
