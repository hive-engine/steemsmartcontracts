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
const pmContractPayload = setupContractPayload('packmanager', './contracts/packmanager.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

function assertTrait(traitObj, nft, edition, index, name) {
  assert.equal(traitObj.nft, nft);
  assert.equal(traitObj.edition, edition);
  assert.equal(traitObj.index, index);
  assert.equal(traitObj.name, name);
}

function assertInstance(instObj, account, ownedBy, edition, foil, type) {
  assert.equal(instObj.account, account);
  assert.equal(instObj.ownedBy, ownedBy);
  assert.equal(instObj.properties.edition, edition);
  assert.equal(instObj.properties.foil, foil);
  assert.equal(instObj.properties.type, type);
}

// packmanager
describe('packmanager', function() {
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "999", "typeAddFee": "5" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      // uncomment to check errors with contract deployment
      //const block1 = await fixture.database.getBlockInfo(1);
      //const transactionsBlock1 = block1.transactions;
      //console.log(JSON.parse(transactionsBlock1[0].logs).errors[0]);

      // check if the params updated OK
      const params = await fixture.database.findOne({
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
        fixture.tearDown();
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'updateParams', '{ "registerFee": "999", "typeAddFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "wrongKey": "123" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": 666 }'));

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
        contract: 'packmanager',
        table: 'params',
        query: {}
      });

      assert.equal(params.registerFee, '1000');
      assert.equal(params.typeAddFee, '1');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('opens packs', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1060", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol":"PACK", "to":"cryptomancer", "quantity":"50", "isSignedWithActiveKey":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [33, 66, 100], "rarityChance": [300, 1000], "teamChance": [1, 3], "isSignedWithActiveKey": true }'));

      // add some types
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 0, "rarity": 0, "team": 0, "name": "Tank", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 1, "rarity": 0, "team": 1, "name": "Destroyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 1, "rarity": 0, "team": 0, "name": "Submarine", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 0, "team": 1, "name": "B52 Bomber", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 1, "team": 0, "name": "Fighter Plane", "isSignedWithActiveKey": true }'));

      // test failure cases first
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5.5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": -5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 21, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "50", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "50.123456789123456789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "BAD", "amount": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "999999", "isSignedWithActiveKey": true }'));

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
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.01", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.0499", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol":"PACK", "to":"aggroed", "quantity":"500", "isSignedWithActiveKey":true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));

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
      console.log(JSON.parse(transactionsBlock2[3].logs).errors[0]);
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'contract cannot afford issuance');

      // make sure pack balance did not change
      let balances = await fixture.database.find({
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
      balances = await fixture.database.find({
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
      assert.equal(balances[0].balance, '560.00000000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'BEE');
      assert.equal(balances[1].balance, '549.94010000');

      balances = await fixture.database.find({
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

      let managedNft = await fixture.database.find({
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
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'deposit', '{ "nftSymbol": "WAR", "amount": "0.0001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'open', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "packs": 5, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block3 = await fixture.database.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;

      console.log(transactionsBlock3[0].logs);
      console.log(transactionsBlock3[1].logs);
      assert.equal(JSON.parse(transactionsBlock3[1].logs).errors, undefined);

      // check that all balances updated
      balances = await fixture.database.find({
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

      balances = await fixture.database.find({
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
      assert.equal(balances[0].balance, '560.06000000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'BEE');
      assert.equal(balances[1].balance, '549.94000000');

      balances = await fixture.database.find({
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

      managedNft = await fixture.database.find({
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

      const nftInstances = await fixture.database.find({
        contract: 'nft',
        table: 'WARinstances',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(nftInstances);
      assert.equal(nftInstances.length, 15);
      assertInstance(nftInstances[0], 'aggroed', 'u', 0, 1, 4);
      assertInstance(nftInstances[1], 'aggroed', 'u', 0, 0, 4);
      assertInstance(nftInstances[2], 'aggroed', 'u', 0, 0, 4);
      assertInstance(nftInstances[3], 'aggroed', 'u', 0, 1, 4);
      assertInstance(nftInstances[4], 'aggroed', 'u', 0, 0, 0);
      assertInstance(nftInstances[5], 'aggroed', 'u', 0, 0, 2);
      assertInstance(nftInstances[6], 'aggroed', 'u', 0, 0, 4);
      assertInstance(nftInstances[7], 'aggroed', 'u', 0, 0, 1);
      assertInstance(nftInstances[8], 'aggroed', 'u', 0, 1, 2);
      assertInstance(nftInstances[9], 'aggroed', 'u', 0, 0, 2);
      assertInstance(nftInstances[10], 'aggroed', 'u', 0, 0, 1);
      assertInstance(nftInstances[11], 'aggroed', 'u', 0, 0, 0);
      assertInstance(nftInstances[12], 'aggroed', 'u', 0, 0, 1);
      assertInstance(nftInstances[13], 'aggroed', 'u', 0, 0, 0);
      assertInstance(nftInstances[14], 'aggroed', 'u', 0, 0, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('adds and edits types', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1060", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "editionName": "Ultimate War Edition", "numRolls": 10, "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "edition": 1, "editionName": "War Modern Expansion", "numRolls": 10, "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));

      // add some types
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 1, "rarity": 1, "team": 3, "name": "Tank", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 2, "team": 0, "name": "Destroyer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 0, "category": 2, "rarity": 3, "team": 3, "name": "Submarine", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 1, "category": 3, "rarity": 4, "team": 0, "name": "B52 Bomber", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'addType', '{ "nftSymbol": "WAR", "edition": 1, "category": 3, "rarity": 5, "team": 3, "name": "Fighter Plane", "isSignedWithActiveKey": true }'));

      // do some updates
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updateType', '{ "nftSymbol": "WAR", "edition": 1, "typeId": 1, "name": "Japanese Zero Fighter", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'deleteType', '{ "nftSymbol": "WAR", "edition": 0, "typeId": 1, "isSignedWithActiveKey": true }'));

      // verify properties can't be updated after switching on the RO flag
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updateEdition', '{ "nftSymbol": "WAR", "edition": 1, "teamRO": true, "nameRO": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updateType', '{ "nftSymbol": "WAR", "edition": 1, "typeId": 1, "name": "Space Shuttle", "isSignedWithActiveKey": true }'));

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
      console.log(transactionsBlock1[12].logs);
      console.log(transactionsBlock1[13].logs);
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(transactionsBlock1[16].logs);
      console.log(transactionsBlock1[17].logs);
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);

      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'cannot edit read-only properties');

      // check if account balance updated OK
      const balances = await fixture.database.find({
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
      assert.equal(balances[0].balance, 1060);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 0);

      // check that types were added
      const types = await fixture.database.find({
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
      const underManagement = await fixture.database.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      console.log(underManagement[0].editionMapping);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(JSON.stringify(underManagement[0].editionMapping), '{"0":{"nextTypeId":3,"editionName":"Ultimate War Edition","categoryRO":false,"rarityRO":false,"teamRO":false,"nameRO":false},"1":{"nextTypeId":2,"editionName":"War Modern Expansion","categoryRO":false,"rarityRO":false,"teamRO":true,"nameRO":true}}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('registers new pack settings and updates settings', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'packmanager', 'updateParams', '{ "registerFee": "500", "typeAddFee": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"550", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACK", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTWO", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true, "name": "token", "url": "https://token.com", "symbol": "PACKTHREE", "precision": 3, "maxSupply": "2000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'nft', 'create', '{ "name": "Dummy Test NFT", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WARPED", "url": "https://mywargame.com", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "editionName": "Ultimate War Edition", "numRolls": 10, "cardsPerPack": 5, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));

      // verify that editionName doesn't need to be provided if the edition has previously been
      // created in a prior pack registration
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTHREE", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "cardsPerPack": 6, "foilChance": [51, 101], "categoryChance": [71, 91, 101], "rarityChance": [601, 801, 901, 976, 1001], "teamChance": [1001, 2801, 3001], "isSignedWithActiveKey": true }'));

      // finalize PACKTHREE so we can verify that settings can't be updated once finalized
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updatePack', '{ "packSymbol": "PACKTHREE", "nftSymbol": "WAR", "isFinalized": true, "isSignedWithActiveKey": true }'));

      // set some trait names
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 1, "name": "Gold", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "category", "index": 0, "name": "Air", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "category", "index": 1, "name": "Ground", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "category", "index": 2, "name": "Naval", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "rarity", "index": 0, "name": "Common", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "rarity", "index": 1, "name": "Uncommon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "rarity", "index": 2, "name": "Rare", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "rarity", "index": 3, "name": "Legendary", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "team", "index": 0, "name": "Marines", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "team", "index": 1, "name": "Rogue Squadron", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "team", "index": 2, "name": "Carrier Group", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "team", "index": 3, "name": "Light Brigade", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "team", "index": 2, "name": "Naval Strike Group", "isSignedWithActiveKey": true }'));

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
      console.log(transactionsBlock1[11].logs);
      console.log(transactionsBlock1[12].logs);
      console.log(transactionsBlock1[13].logs);
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(transactionsBlock1[16].logs);
      console.log(transactionsBlock1[17].logs);
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);

      // check if trait names were set OK
      let traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'foils',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Standard');
      assertTrait(traits[1], 'WAR', 0, 1, 'Gold');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'categories',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Air');
      assertTrait(traits[1], 'WAR', 0, 1, 'Ground');
      assertTrait(traits[2], 'WAR', 0, 2, 'Naval');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'rarities',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Common');
      assertTrait(traits[1], 'WAR', 0, 1, 'Uncommon');
      assertTrait(traits[2], 'WAR', 0, 2, 'Rare');
      assertTrait(traits[3], 'WAR', 0, 3, 'Legendary');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'teams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Marines');
      assertTrait(traits[1], 'WAR', 0, 1, 'Rogue Squadron');
      assertTrait(traits[2], 'WAR', 0, 2, 'Naval Strike Group');
      assertTrait(traits[3], 'WAR', 0, 3, 'Light Brigade');

      // check if the pack was registered OK
      let settings = await fixture.database.find({
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
      assert.equal(settings[0].numRolls, 10);
      assert.equal(settings[0].isFinalized, false);
      assert.equal(JSON.stringify(settings[0].foilChance), '[50,100]');
      assert.equal(JSON.stringify(settings[0].categoryChance), '[70,90,100]');
      assert.equal(JSON.stringify(settings[0].rarityChance), '[600,800,900,975,1000]');
      assert.equal(JSON.stringify(settings[0].teamChance), '[1000,2800,3000]');
      assert.equal(settings[1].account, 'cryptomancer');
      assert.equal(settings[1].symbol, 'PACKTHREE');
      assert.equal(settings[1].nft, 'WAR');
      assert.equal(settings[1].edition, 0);
      assert.equal(settings[1].cardsPerPack, 6);
      assert.equal(settings[1].numRolls, 10);
      assert.equal(settings[1].isFinalized, true);
      assert.equal(JSON.stringify(settings[1].foilChance), '[51,101]');
      assert.equal(JSON.stringify(settings[1].categoryChance), '[71,91,101]');
      assert.equal(JSON.stringify(settings[1].rarityChance), '[601,801,901,976,1001]');
      assert.equal(JSON.stringify(settings[1].teamChance), '[1001,2801,3001]');

      // check if account balance updated OK
      const balances = await fixture.database.find({
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
      assert.equal(balances[0].balance, 1100);
      assert.equal(balances[1].account, 'cryptomancer');
      assert.equal(balances[1].symbol, CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balances[1].balance, 0);

      // test failure cases
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "numRolls": 10, "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "BAD", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "BAD", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"500", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 1, "numRolls": 10, "editionName": "Next War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 0, "numRolls": 10, "editionName": "Ultimate War Edition", "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 500, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'registerPack', '{ "packSymbol": "PACKTWO", "nftSymbol": "WAR", "edition": 1, "numRolls": 10, "cardsPerPack": 3, "foilChance": [50, 100], "categoryChance": [70, 90, 100], "rarityChance": [600, 800, 900, 975, 1000], "teamChance": [1000, 2800, 3000], "isSignedWithActiveKey": true }'));

      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 0, "name": "StandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandardStandard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 1.12345, "name": "Standard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WARBOY", "edition": 0, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'aggroed', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WARPED", "edition": 0, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 5, "trait": "foil", "index": 0, "name": "Standard", "isSignedWithActiveKey": true }'));

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

      console.log(JSON.parse(transactionsBlock2[0].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[1].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[2].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[3].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[4].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[7].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[8].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[9].logs).errors[0]);

      console.log(JSON.parse(transactionsBlock2[10].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[11].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[12].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[13].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[14].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[15].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[16].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'you must have enough tokens to cover the registration fee');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'pack symbol must exist');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'NFT not under management');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'not authorized to register');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'pack already registered for WAR');
      assert.equal(JSON.parse(transactionsBlock2[8].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[9].logs).errors[0], 'must provide a name for the new edition');

      assert.equal(JSON.parse(transactionsBlock2[10].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[11].logs).errors[0], 'invalid trait name: letters, numbers, whitespaces only, max length of 100');
      assert.equal(JSON.parse(transactionsBlock2[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[13].logs).errors[0], 'NFT symbol must exist');
      assert.equal(JSON.parse(transactionsBlock2[14].logs).errors[0], 'not authorized for updates');
      assert.equal(JSON.parse(transactionsBlock2[15].logs).errors[0], 'NFT not under management');
      assert.equal(JSON.parse(transactionsBlock2[16].logs).errors[0], 'edition not registered');

      // verify contract now manages the new NFT
      let underManagement = await fixture.database.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      console.log(underManagement[0].editionMapping);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(JSON.stringify(underManagement[0].editionMapping), '{"0":{"nextTypeId":0,"editionName":"Ultimate War Edition","categoryRO":false,"rarityRO":false,"teamRO":false,"nameRO":false}}');

      // update some settings
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      // this should fail as edition 3 hasn't been registered
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updatePack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "edition": 3, "isSignedWithActiveKey": true }'));
      // this should fail as pack is already finalized
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updatePack', '{ "packSymbol": "PACKTHREE", "nftSymbol": "WAR", "numRolls": 3, "isSignedWithActiveKey": true }'));

      // this should succeed
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updatePack', '{ "packSymbol": "PACK", "nftSymbol": "WAR", "isFinalized": true, "cardsPerPack": 7, "numRolls": 4, "foilChance": [51, 101], "categoryChance": [70, 90, 95, 100], "rarityChance": [600, 800, 900, 975, 1000, 1200], "teamChance": [2800, 3000], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'updateEdition', '{ "nftSymbol": "WAR", "edition": 0, "editionName": "Mega Uber War Edition", "categoryRO": true, "rarityRO": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'setTraitName', '{ "nftSymbol": "WAR", "edition": 0, "trait": "rarity", "index": 1, "name": "Less Common", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block3 = await fixture.database.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;
      console.log(transactionsBlock3[0].logs);
      console.log(transactionsBlock3[1].logs);
      console.log(transactionsBlock3[2].logs);
      console.log(transactionsBlock3[3].logs);
      console.log(transactionsBlock3[4].logs);
      assert.equal(JSON.parse(transactionsBlock3[0].logs).errors[0], 'edition not registered');
      assert.equal(JSON.parse(transactionsBlock3[1].logs).errors[0], 'pack settings already finalized');

      // check if the pack settings were updated OK
      settings = await fixture.database.find({
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
      assert.equal(settings[0].numRolls, 4);
      assert.equal(settings[0].isFinalized, true);
      assert.equal(JSON.stringify(settings[0].foilChance), '[51,101]');
      assert.equal(JSON.stringify(settings[0].categoryChance), '[70,90,95,100]');
      assert.equal(JSON.stringify(settings[0].rarityChance), '[600,800,900,975,1000,1200]');
      assert.equal(JSON.stringify(settings[0].teamChance), '[2800,3000]');

      // check if edition name was updated OK
      underManagement = await fixture.database.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      console.log(underManagement[0].editionMapping);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');
      assert.equal(JSON.stringify(underManagement[0].editionMapping), '{"0":{"nextTypeId":0,"editionName":"Mega Uber War Edition","categoryRO":true,"rarityRO":true,"teamRO":false,"nameRO":false}}');

      // check if trait names were updated OK
      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'foils',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Standard');
      assertTrait(traits[1], 'WAR', 0, 1, 'Gold');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'categories',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Air');
      assertTrait(traits[1], 'WAR', 0, 1, 'Ground');
      assertTrait(traits[2], 'WAR', 0, 2, 'Naval');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'rarities',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Common');
      assertTrait(traits[1], 'WAR', 0, 1, 'Less Common');
      assertTrait(traits[2], 'WAR', 0, 2, 'Rare');
      assertTrait(traits[3], 'WAR', 0, 3, 'Legendary');

      traits = await fixture.database.find({
        contract: 'packmanager',
        table: 'teams',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });
      console.log(traits);
      assertTrait(traits[0], 'WAR', 0, 0, 'Marines');
      assertTrait(traits[1], 'WAR', 0, 1, 'Rogue Squadron');
      assertTrait(traits[2], 'WAR', 0, 2, 'Naval Strike Group');
      assertTrait(traits[3], 'WAR', 0, 3, 'Light Brigade');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('creates a collection NFT definition', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"100", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

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
      console.log(transactionsBlock1[5].logs);

      // check if the NFT was created OK
      const token = await fixture.database.findOne({
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
      const balances = await fixture.database.find({
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
      const underManagement = await fixture.database.find({
        contract: 'packmanager',
        table: 'managedNfts',
        query: {},
        indexes: [{index: '_id', descending: false}],
      });

      console.log(underManagement);
      assert.equal(underManagement[0].nft, 'WAR');
      assert.equal(underManagement[0].feePool, '0');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not create a collection NFT definition', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(pmContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "50", "dataPropertyCreationFee": "5" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"49", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

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
        query: { symbol: 'WAR' }
      });

      assert.equal(token, null);

      const block1 = await fixture.database.getBlockInfo(1);
      const transactionsBlock1 = block1.transactions;

      console.log(JSON.parse(transactionsBlock1[5].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock1[6].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must have enough tokens to cover the NFT creation');

      // test bad params
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "&&&^^^", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

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

      console.log(JSON.parse(transactionsBlock2[1].logs).errors[0]);
      console.log(JSON.parse(transactionsBlock2[1].logs).errors[1]);

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[1], 'error creating NFT');

      // verify nothing subtracted from account balance
      const balances = await fixture.database.find({
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
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"50", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'cryptomancer', 'packmanager', 'createNft', '{ "name": "War Game Military Units", "orgName": "Wars R Us Inc", "productName": "War Game", "symbol": "WAR", "url": "https://mywargame.com", "isFoilReadOnly": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      const block3 = await fixture.database.getBlockInfo(3);
      const transactionsBlock3 = block3.transactions;
      
      console.log(JSON.parse(transactionsBlock3[2].logs).errors[0]);

      assert.equal(JSON.parse(transactionsBlock3[2].logs).errors[0], 'symbol already exists');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
