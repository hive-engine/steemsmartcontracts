/* eslint-disable */
const assert = require('assert');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');

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
const critterContractPayload = setupContractPayload('crittermanager', './contracts/crittermanager.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

// crittermanager
describe('crittermanager', function() {
  this.timeout(200000);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'updateParams', `{ "editionMapping": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the params updated OK
      const params = await fixture.database.findOne({
        contract: 'crittermanager',
        table: 'params',
        query: {}
      });

      

      assert.equal(JSON.stringify(params.editionMapping), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4}`);

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateParams', `{ "editionMapping": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'updateParams', `{ "wrongKey": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3,"UNTAMED":4} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'updateParams', `{ "editionMapping": 666 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // params should not have changed from their initial values
      const params = await fixture.database.findOne({
        contract: 'crittermanager',
        table: 'params',
        query: {}
      });

      

      assert.equal(JSON.stringify(params.editionMapping), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":1,"ALPHA":2,"BETA":3}`);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('sets up the NFT', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the NFT was created OK
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      

      assert.equal(token.symbol, 'CRITTER');
      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.name, 'Mischievous Crypto Critters');
      assert.equal(token.maxSupply, 0);
      assert.equal(token.supply, 0);
      assert.equal(JSON.stringify(token.authorizedIssuingContracts), '["crittermanager"]');
      assert.equal(token.circulatingSupply, 0);
      assert.equal(token.delegationEnabled, false);
      assert.equal(token.undelegationCooldown, 0);
      
      const properties = token.properties;

      assert.equal(properties.edition.type, "number");
      assert.equal(properties.edition.isReadOnly, true);
      assert.equal(properties.type.type, "number");
      assert.equal(properties.type.isReadOnly, true);
      assert.equal(properties.rarity.type, "number");
      assert.equal(properties.rarity.isReadOnly, true);
      assert.equal(properties.isGoldFoil.type, "boolean");
      assert.equal(properties.isGoldFoil.isReadOnly, true);
      assert.equal(properties.name.type, "string");
      assert.equal(properties.name.isReadOnly, false);
      assert.equal(properties.xp.type, "number");
      assert.equal(properties.xp.isReadOnly, false);
      assert.equal(properties.hp.type, "number");
      assert.equal(properties.hp.isReadOnly, false);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not set up the NFT', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": false }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // verify NFT was not created
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      
      assert.equal(token, null);

      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');

      // test that you can't create CRITTER twice
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block2 = await fixture.database.getBlockInfo(2);
      const transactionsBlock2 = block2.transactions;
      

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'CRITTER already exists');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('hatches critters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferToContract', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"crittermanager", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 10 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the expected amount of critters were issued
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      

      assert.equal(token.supply, 50);
      assert.equal(token.circulatingSupply, 50);

      // check if the critters were issued OK
      const instances = await fixture.database.find({
        contract: 'nft',
        table: 'CRITTERinstances',
        query: {},
      });

      

      assert.equal(instances.length, 50);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].properties.edition, 1);

      // ensure packs were subtracted from purchasing account
      let balance = await fixture.database.findOne({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'aggroed' }
      });

      

      assert.equal(balance.symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balance.balance, '990.00000000');

      // ensure issuance fees were paid by the contract, not the calling user
      balance = await fixture.database.findOne({
        contract: 'tokens',
        table: 'contractsBalances',
        query: { account: 'crittermanager' }
      });

      

      assert.equal(balance.symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balance.balance, '960.00000000'); // 10 packs x 5 critters per pack x 0.8 fee per critter = 40 token issuance fee

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not hatch critters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"9", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferToContract', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"crittermanager", "quantity":"39.999", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": false, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 10 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "GAMMA", "packs": 10 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 0 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 11 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 3.14159 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": "notanumber" }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 10 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 10 }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // make sure no critters were issued
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      assert.equal(token.supply, 0);
      assert.equal(token.circulatingSupply, 0);

      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid pack symbol');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'packs must be an integer between 1 and 10');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'packs must be an integer between 1 and 10');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'packs must be an integer between 1 and 10');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'packs must be an integer between 1 and 10');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'you must have enough pack tokens');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'contract cannot afford issuance');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('names critters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferToContract', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"crittermanager", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 1 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "id": "2", "name": "Toothless" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // check if the expected amount of critters were issued
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      assert.equal(token.supply, 5);
      assert.equal(token.circulatingSupply, 5);

      // check if the critter was renamed OK
      const instance = await fixture.database.findOne({
        contract: 'nft',
        table: 'CRITTERinstances',
        query: { _id: 2 },
      });

      

      assert.equal(instance.account, 'aggroed');
      assert.equal(instance.ownedBy, 'u');
      assert.equal(instance.properties.name, 'Toothless');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not name critters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(critterContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transferToContract', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"crittermanager", "quantity":"1000", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'createNft', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'hatch', `{ "isSignedWithActiveKey": true, "packSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "packs": 1 }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "name": "Toothless" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "id": "notanumber", "name": "Toothless" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "id": "2", "name": "tooooooooooooolllllllooooooooooooonnnnnnnnnnnnnggggggggggggggggg" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'crittermanager', 'updateName', '{ "id": "222", "name": "Mega Drive" }')); // id doesn't exist
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'crittermanager', 'updateName', '{ "id": "2", "name": "Mega Drive" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;
      
      
      
      
      
      

      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'must be the token holder');

      // check if the expected amount of critters were issued
      const token = await fixture.database.findOne({
        contract: 'nft',
        table: 'nfts',
        query: { symbol: 'CRITTER' }
      });

      assert.equal(token.supply, 5);
      assert.equal(token.circulatingSupply, 5);

      // make sure the critter was not renamed
      const instance = await fixture.database.findOne({
        contract: 'nft',
        table: 'CRITTERinstances',
        query: { _id: 2 },
      });

      

      assert.equal(instance.account, 'aggroed');
      assert.equal(instance.ownedBy, 'u');
      assert.equal(instance.properties.name, '');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
