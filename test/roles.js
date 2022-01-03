/* eslint-disable */
const assert = require('assert').strict;
const { MongoClient } = require('mongodb');
const dhive = require('@hiveio/dhive');
const enchex = require('crypto-js/enc-hex');
const BigNumber = require('bignumber.js');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const distributionContractPayload = setupContractPayload('distribution', './contracts/distribution.js');
const inflationContractPayload = setupContractPayload('inflation', './contracts/inflation.js');
const witnessContractPayload = setupContractPayload('witnesses', './contracts/witnesses.js');
const dtfContractPayload = setupContractPayload('tokenfunds', './contracts/tokenfunds.js');
const contractPayload = setupContractPayload('roles', './contracts/roles.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertUserWeight(account, symbol, weight = 0) {
  const res = await fixture.database.findOne({
    contract: 'roles',
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

async function assertUserApproval(account, candidateId, present = true) {
  const res = await fixture.database.findOne({
    contract: 'roles',
    table: 'approvals',
    query: {
      from: account,
      to: candidateId
    }
  });

  if (!present) {
    assert(!res, `candidateId found for ${account}, expected none.`);
    return;
  }
  assert.ok(res, `No candidateId for ${account}, ${candidateId}`);
}

async function assertContractBalance(account, symbol, balance) {
  const res = await fixture.database.findOne({
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

async function assertWeightConsistency(candidateId, voteSymbol) {
  const prop = await fixture.database.findOne({
    contract: 'roles',
    table: 'candidates',
    query: { _id: candidateId }
  });
  const app = await fixture.database.find({
    contract: 'roles',
    table: 'approvals',
    query: { to: candidateId }
  });
  let appWeight = 0;
  for (let i = 0; i < app.length; i += 1) {
    const acct = await fixture.database.findOne({
      contract: 'roles',
      table: 'accounts',
      query: { account: app[i].from }
    });
    const wIndex = acct.weights.findIndex(x => x.symbol === voteSymbol);
    if (wIndex !== -1) {
      appWeight = BigNumber(appWeight).plus(acct.weights[wIndex].weight).toNumber();
    }
  }
  assert.strictEqual(appWeight, BigNumber(prop.approvalWeight.$numberDecimal).toNumber(), `prop.approvalWeight (${prop.approvalWeight.$numberDecimal}) doesn\'t equal total of account weights (${appWeight})`);
}

async function setUpEnv(configOverride = {}) {
  let transactions = [];
  let refBlockNumber = fixture.getNextRefBlockNumber();
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessContractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(dtfContractPayload)));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
  
  let block = {
    refHiveBlockNumber: refBlockNumber,
    refHiveBlockId: 'ABCD1',
    prevRefHiveBlockId: 'ABCD2',
    timestamp: '2018-05-31T00:00:00',
    transactions,
  };

  await fixture.sendBlock(block);
  await tableAsserts.assertNoErrorInLastBlock();

  transactions = [];
  refBlockNumber = fixture.getNextRefBlockNumber();
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick', '{ "contractName": "roles", "tickAction": "checkPendingInstances"}'));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "5000", "isSignedWithActiveKey": true }`));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "buffet", "quantity": "5000", "isSignedWithActiveKey": true }`));

  block = {
    refHiveBlockNumber: refBlockNumber,
    refHiveBlockId: 'ABCD1',
    prevRefHiveBlockId: 'ABCD2',
    timestamp: '2018-05-31T01:00:00',
    transactions,
  };

  await fixture.sendBlock(block);
  await tableAsserts.assertNoErrorInLastBlock();
}

// distribution test suite
describe('roles tests', function () {
  this.timeout(30000);

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

  it('should not create invalid instance', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "PRO", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "ABC", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "PRO", "amount": "1" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[1], 'you must use a transaction signed with your active key');
      assertError(txs[2], 'invalid candidateFee properties');
      assertError(txs[3], 'invalid candidateFee token or precision');
      assertError(txs[4], 'voteToken must have staking enabled');

      res = await fixture.database.find({
        contract: 'roles',
        table: 'instances',
        query: { _id: 1 }
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid instance created');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should create valid instance', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      await tableAsserts.assertNoErrorInLastBlock();
      res = await fixture.database.findOne({
        contract: 'roles',
        table: 'instances',
        query: {
          _id: 1
        }
      });
      assert.ok(res, 'newly created instance not found');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update invalid instance', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": "1", "candidateFee": { "method": "burn", "symbol": "PRO", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": "1", "candidateFee": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": "1", "candidateFee": { "method": "burn", "symbol": "ABC", "amount": "1" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[3], 'you must use a transaction signed with your active key');
      assertError(txs[4], 'invalid candidateFee object');
      assertError(txs[5], 'invalid candidateFee token or precision');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should update valid instance', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": "1", "candidateFee": { "method": "issuer", "symbol": "PRO", "amount": "10" }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.findOne({
        contract: 'roles',
        table: 'instances',
        query: {
          _id: 1
        }
      });
      const expected = {
        _id: 1,
        voteToken: 'PRO',
        candidateFee: { method: 'issuer', symbol: 'PRO', amount: '10' },
        active: false,
        creator: 'donchate',
        lastTickTime: 1527811200000
      }
      assert.deepEqual(res, expected, 'updates not found in instance');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should allow owner to update params', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'roles', 'updateParams', '{ "instanceCreationFee": "1", "instanceUpdateFee": "1", "instanceTickHours": "1", "roleCreationFee": "1", "roleUpdateFee": "1", "maxSlots": "1", "maxInstancesPerBlock": "1", "maxRolesPerBlock": "1", "maxAccountApprovals": "1", "processQueryLimit": "1", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.findOne({
        contract: 'roles',
        table: 'params',
        query: {},
      });
      const expected = {
        _id: 1,
        instanceCreationFee: '1',
        instanceUpdateFee: '1',
        instanceTickHours: '1',
        roleCreationFee: '1',
        roleUpdateFee: '1',
        maxSlots: 1,
        maxInstancesPerBlock: 1,
        maxRolesPerBlock: 1,
        maxAccountApprovals: 1,
        processQueryLimit: 1
      };
      assert.deepEqual(res, expected, 'updates not as expected');
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not create invalid roles', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "2", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buffet', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker X", "voteThreshold": "-1", "mainSlots": "0", "backupSlots": "5", "tickHours": "12"}], "isSignedWithActiveKey": true }'));
      
      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[3], 'you must use a transaction signed with your active key');
      assertError(txs[4], 'instance not found');
      assertError(txs[5], 'invalid roles object');
      assertError(txs[6], 'must be instance creator');
      assertError(txs[7], 'invalid roles properties');
    
      res = await fixture.database.find({
        contract: 'roles',
        table: 'roles',
        query: {}
      });
  
      assert.ok(!res || res.length === 0, 'uncaught errors, invalid role created');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should create valid roles', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      // let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();
      let resx = await fixture.database.find({
        contract: 'roles',
        table: 'roles',
        query: {}
      });
      assert.ok(resx.length === 2, 'newly created roles not found');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update invalid role', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buffet', 'roles', 'updateRole', '{ "roleId": "1", "mainSlots": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "name": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "voteThreshold": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "mainSlots": "0", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "backupSlots": "36", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "tickHours": "6", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      let txs = res.transactions;

      assertError(txs[4], 'specify at least one field to update');
      assertError(txs[5], 'must be instance creator');
      assertError(txs[6], 'name must be a string less than 50 characters');
      assertError(txs[7], 'voteThreshold must be greater than or equal to 0, precision matching voteToken');
      assertError(txs[8], 'mainSlots must be a integer between 1 - params.maxSlots');
      assertError(txs[9], 'backupSlots must be an integer between 0 - remainingSlots');
      assertError(txs[10], 'tickHours must be an integer greater than or equal to, and a multiple of params.instanceTickHours');
    
      res = await fixture.database.findOne({
        contract: 'roles',
        table: 'roles',
        query: { _id: 1 }
      });
      // console.log(res);
      const original = {
        _id: 1,
        instanceId: 1,
        name: 'Worker 1',
        voteThreshold: '0',
        mainSlots: '5',
        backupSlots: '2',
        tickHours: '24',
        active: true,
        lastTickTime: 0,
        totalApprovalWeight: { $numberDecimal: '0' }
      };
      assert.deepEqual(res, original, 'role has changed');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update valid role', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "roleId": "1", "name": "Worker 1A", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      // let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);      
      await tableAsserts.assertNoErrorInLastBlock();
      let resx = await fixture.database.findOne({
        contract: 'roles',
        table: 'roles',
        query: {
          _id: 1,
        }
      });
      const updated = {
        _id: 1,
        instanceId: 1,
        name: 'Worker 1A',
        voteThreshold: '0',
        mainSlots: '5',
        backupSlots: '2',
        tickHours: '24',
        active: true,
        lastTickTime: 0,
        totalApprovalWeight: { $numberDecimal: '0' }
      };

      assert.deepEqual(resx, updated, 'updates not found in role');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should not run inactive roles', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "candidateFee": { "method": "burn", "symbol": "BEE", "amount": "0" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'setInstanceActive', '{ "instanceId": "1", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": "1", "roleId": 1, "active": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'deposit', '{ "roleId": "2", "symbol": "BEE", "quantity": "1", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buffet', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length === 0, 'Expected to find no virtualTransactions');

      // balance asserts
      await assertContractBalance('roles', 'BEE', '1');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should run roles and update approvals', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "10000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000001", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "PRO", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "PRO", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "PRO", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "PRO", "quantity": "1000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'setInstanceActive', '{ "instanceId": "1", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'setRoleActive', '{ "roleId": "1", "active": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'deposit', '{ "roleId": "2", "symbol": "BEE", "quantity": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'approveCandidate', '{ "id": "2" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      // weight asserts
      await assertUserWeight('voter1', 'PRO', '1000.00000000');
      await assertUserWeight('voter2', 'PRO', '10000.00000000');
      await assertUserWeight('voter3', 'PRO', '100000.00000000');
      await assertUserWeight('voter4', 'PRO', '1000000.00000000');
      await assertUserApproval('voter1', 1);
      await assertUserApproval('voter2', 1);
      await assertUserApproval('voter3', 1);
      await assertUserApproval('voter4', 1);
      await assertWeightConsistency(1, 'PRO');
      await assertWeightConsistency(2, 'PRO');
      await assertWeightConsistency(3, 'PRO');
      await assertWeightConsistency(4, 'PRO');


      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to": "voter4", "symbol": "PRO", "quantity": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'unstake', '{ "symbol": "PRO", "quantity": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'toggleApplyForRole', '{ "roleId": "2", "active": false, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertWeightConsistency(1, 'PRO');
      await assertWeightConsistency(2, 'PRO');
      await assertWeightConsistency(3, 'PRO');
      await assertWeightConsistency(4, 'PRO');

      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'rolePayment');
      assert.ok(e, 'Expected to find rolePayment event');

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'organizer', symbol: 'BEE', balance: '0.50000000'});
      await tableAsserts.assertUserBalances({ account: 'voter1', symbol: 'BEE', balance: '0.50000000'});
      await assertContractBalance('roles', 'BEE', '0.00000000');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run roles over several blocks', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'roles', 'updateParams', '{ "maxInstancesPerBlock": "1", "maxRolesPerBlock": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "PRO", "precision": 8, "maxSupply": "10000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "PRO", "unstakingCooldown": 3, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "PRO", "quantity": "1000001", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "PRO", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "PRO", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "PRO", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "PRO", "quantity": "1000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createInstance', '{ "voteToken": "PRO", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'setInstanceActive', '{ "instanceId": "1", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": "1", "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "3", "backupSlots": "1", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "4", "backupSlots": "0", "tickHours": "24"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'deposit', '{ "roleId": "1", "symbol": "BEE", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'deposit', '{ "roleId": "2", "symbol": "BEE", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'roles', 'applyForRole', '{ "roleId": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'applyForRole', '{ "roleId": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'applyForRole', '{ "roleId": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'approveCandidate', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'approveCandidate', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'approveCandidate', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'roles', 'approveCandidate', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'approveCandidate', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'roles', 'approveCandidate', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'roles', 'approveCandidate', '{ "id": "3" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      let res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      // weight asserts
      await assertUserWeight('voter1', 'PRO', '1000.00000000');
      await assertUserWeight('voter2', 'PRO', '10000.00000000');
      await assertUserWeight('voter3', 'PRO', '100000.00000000');
      await assertUserWeight('voter4', 'PRO', '1000000.00000000');
      await assertUserApproval('voter1', 1);
      await assertUserApproval('voter2', 1);
      await assertUserApproval('voter3', 1);
      await assertUserApproval('voter4', 1);
      await assertWeightConsistency(1, 'PRO');
      await assertWeightConsistency(2, 'PRO');
      await assertWeightConsistency(3, 'PRO');
      await assertWeightConsistency(4, 'PRO');


      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'approveCandidate', '{ "id": "2" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertWeightConsistency(1, 'PRO');
      await assertWeightConsistency(2, 'PRO');
      await assertWeightConsistency(3, 'PRO');
      await assertWeightConsistency(4, 'PRO');

      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'rolePayment');
      assert.ok(e, 'Expected to find rolePayment event');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'disapproveCandidate', '{ "id": "2" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:03',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertWeightConsistency(1, 'PRO');
      await assertWeightConsistency(2, 'PRO');
      await assertWeightConsistency(3, 'PRO');
      await assertWeightConsistency(4, 'PRO');

      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      e = virtualEventLog.events.find(x => x.event === 'rolePayment');
      assert.ok(e, 'Expected to find rolePayment event');

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'organizer', symbol: 'BEE', balance: '25.00000000'});
      await tableAsserts.assertUserBalances({ account: 'voter1', symbol: 'BEE', balance: '25.00000000'});
      await tableAsserts.assertUserBalances({ account: 'voter2', symbol: 'BEE', balance: '25.00000000'});
      await tableAsserts.assertUserBalances({ account: 'voter3', symbol: 'BEE'});
      await tableAsserts.assertUserBalances({ account: 'voter4', symbol: 'BEE'});
      await assertContractBalance('roles', 'BEE', '125.00000000');

      // let roleState = await fixture.database.find({
      //   contract: 'roles',
      //   table: 'roles',
      //   query: {}
      // });
      // console.log(JSON.stringify(roleState, null, 2));

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'roles', 'approveCandidate', '{ "id": "4" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:06',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      await tableAsserts.assertNoErrorInLastBlock();
      assert.ok(res.virtualTransactions.length == 0, 'Expected to not find virtualTransactions'); 

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  // END TESTS
});
