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
const dtfContractPayload = setupContractPayload('witnesses', './contracts/witnesses.js');
const contractPayload = setupContractPayload('roles', './contracts/roles.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertUserWeight(account, symbol, weight = 0) {
  const res = await fixture.database.findOne({
    contract: 'tokenfunds',
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

async function assertUserApproval(account, proposalId, present = true) {
  const res = await fixture.database.findOne({
    contract: 'tokenfunds',
    table: 'approvals',
    query: {
      from: account,
      to: proposalId
    }
  });

  if (!present) {
    assert(!res, `proposalId found for ${account}, expected none.`);
    return;
  }
  assert.ok(res, `No proposalId for ${account}, ${proposalId}`);
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

async function assertTokenBalance(id, symbol, balance) {
  let hasBalance = false;
  let dist = await fixture.database.findOne({
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

async function assertWeightConsistency(proposalId, voteSymbol) {
  const prop = await fixture.database.findOne({
    contract: 'tokenfunds',
    table: 'proposals',
    query: { _id: proposalId }
  }); 
  const app = await fixture.database.find({
    contract: 'tokenfunds',
    table: 'approvals',
    query: { to: proposalId }
  });
  let appWeight = 0;
  for (let i = 0; i < app.length; i += 1) {
    const acct = await fixture.database.findOne({
      contract: 'tokenfunds',
      table: 'accounts',
      query: { account: app[i].from }
    });
    const wIndex = acct.weights.findIndex(x => x.symbol === voteSymbol);
    if (wIndex !== -1) {
      appWeight = BigNumber(appWeight).plus(acct.weights[wIndex].weight).toNumber();
    }
  }
  assert.equal(appWeight, prop.approvalWeight.$numberDecimal, `prop.approvalWeight (${prop.approvalWeight.$numberDecimal}) doesn\'t equal total of account weights (${appWeight})`);
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
      assertError(txs[2], 'invalid candidateFee object');
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": 1, "candidateFee": { "method": "burn", "symbol": "PRO", "amount": "1" }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": 1, "candidateFee": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": 1, "candidateFee": { "method": "burn", "symbol": "ABC", "amount": "1" }, "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateInstance', '{ "instanceId": 1, "candidateFee": { "method": "issuer", "symbol": "PRO", "amount": "10" }, "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'roles', 'updateParams', '{ "instanceCreationFee": "1", "instanceUpdateFee": "1", "instanceTickHours": "1", "roleCreationFee": "1", "roleUpdateFee": "1", "maxSlots": "1", "maxInstancePerBlock": "1", "maxTxPerBlock": "1", "maxAccountApprovals": "1", "processQueryLimit": "1", "isSignedWithActiveKey": true }'));

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
        maxInstancePerBlock: 1,
        maxTxPerBlock: 1,
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 2, "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buffet', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [{ "name": "Worker X", "voteThreshold": "-1", "mainSlots": "0", "backupSlots": "5", "tickHours": "12"}], "isSignedWithActiveKey": true }'));
      
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 2, "roleId": 1, "name": "123", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'buffet', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "mainSlots": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "name": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "voteThreshold": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "mainSlots": "0", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "backupSlots": "36", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "tickHours": "6", "isSignedWithActiveKey": true }'));

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
      assertError(txs[5], 'instance not found');
      assertError(txs[6], 'must be instance creator');
      assertError(txs[7], 'name must be a string less than 50 characters');
      assertError(txs[8], 'voteThreshold must be greater than or equal to 0, precision matching voteToken');
      assertError(txs[9], 'mainSlots must be a integer between 1 - 40');
      assertError(txs[10], 'backupSlots must be an integer between 0 - 35');
      assertError(txs[11], 'tickHours must be an integer greater than or equal to 24');
    
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
        totalApprovalWeight: 0
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'createRoles', '{ "instanceId": 1, "roles": [{ "name": "Worker 1", "voteThreshold": "0", "mainSlots": "5", "backupSlots": "2", "tickHours": "24"},{ "name": "Worker 2", "voteThreshold": "0", "mainSlots": "1", "backupSlots": "1", "tickHours": "168"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'roles', 'updateRole', '{ "instanceId": 1, "roleId": 1, "name": "Worker 1A", "isSignedWithActiveKey": true }'));

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
        totalApprovalWeight: 0
      };

      assert.deepEqual(resx, updated, 'updates not found in role');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should not run inactive proposals', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-03-16T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-03-18T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Smaller Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-03-18T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'disableProposal', '{ "id": "3", "isSignedWithActiveKey": true }'));

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

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-17T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 0);

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should run proposals and update approvals', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "80000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TST", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "TST", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "TST", "quantity": "100", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "SLV", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorPermlink": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Small Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "5", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "4" }'));

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
      await assertUserWeight('voter1', 'SLV', '1000.00000000');
      await assertUserWeight('voter2', 'SLV', '10000.00000000');
      await assertUserWeight('voter3', 'SLV', '100000.00000000');
      await assertUserWeight('voter4', 'GLD', '10000.00000000');
      await assertUserWeight('organizer', 'GLD', '0.00000000');
      await assertUserApproval('voter1', 2);
      await assertUserApproval('voter2', 2);
      await assertUserApproval('voter3', 2);
      await assertUserApproval('voter4', 3);
      await assertUserApproval('organizer', 3);
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');


      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "TST", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD', balance: '500.00000000'});
      await tableAsserts.assertUserBalances({ account: 'silverstein', symbol: 'GLD', balance: '500.00000000'});
      await assertContractBalance('distribution', 'GLD', '1000.00000000');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run proposals with modified dtfTickHours', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "SLV", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokenfunds', 'updateParams', '{ "dtfTickHours": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorPermlink": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "2000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Small Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "5", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "4" }'));

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
      await assertUserWeight('voter1', 'SLV', '1000.00000000');
      await assertUserWeight('voter2', 'SLV', '10000.00000000');
      await assertUserWeight('voter3', 'SLV', '100000.00000000');
      await assertUserWeight('voter4', 'GLD', '10000.00000000');
      await assertUserWeight('organizer', 'GLD', '0.00000000');
      await assertUserApproval('voter1', 2);
      await assertUserApproval('voter2', 2);
      await assertUserApproval('voter3', 2);
      await assertUserApproval('voter4', 3);
      await assertUserApproval('organizer', 3);
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');


      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

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
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD', balance: '20.83333333'});
      await tableAsserts.assertUserBalances({ account: 'silverstein', symbol: 'GLD', balance: '20.83333333'});
      await assertContractBalance('distribution', 'GLD', '41.87499999');
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD', balance: '41.66666666'});
      await tableAsserts.assertUserBalances({ account: 'silverstein', symbol: 'GLD', balance: '41.66666666'});
      await assertContractBalance('distribution', 'GLD', '83.74999998');
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');      

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });  

  it('should cap funds and proposals', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokens', 'stake', '{ "to":"voter2", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokens', 'stake', '{ "to":"voter3", "symbol": "SLV", "quantity": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "SLV", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokens', 'stake', '{ "to":"voter4", "symbol": "GLD", "quantity": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokenfunds', 'updateParams', '{ "processQueryLimit": "1", "maxDtfsPerBlock": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorPermlink": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "2000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Small Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "5", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter3', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter2', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter4', 'tokenfunds', 'approveProposal', '{ "id": "4" }'));

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
      await assertUserWeight('voter1', 'SLV', '1000.00000000');
      await assertUserWeight('voter2', 'SLV', '10000.00000000');
      await assertUserWeight('voter3', 'SLV', '100000.00000000');
      await assertUserWeight('voter4', 'GLD', '10000.00000000');
      await assertUserWeight('organizer', 'GLD', '0.00000000');
      await assertUserApproval('voter1', 2);
      await assertUserApproval('voter2', 2);
      await assertUserApproval('voter3', 2);
      await assertUserApproval('voter4', 3);
      await assertUserApproval('organizer', 3);
      await assertWeightConsistency(1, 'SLV');
      await assertWeightConsistency(2, 'SLV');
      await assertWeightConsistency(3, 'GLD');
      await assertWeightConsistency(4, 'GLD');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

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
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:GLD');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await assertContractBalance('distribution', 'GLD', '1005.00000000');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:03',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, 'GLD:SLV');
      assert.equal(e.data.funded.length, 2);

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD', balance: '500.00000000'});
      await tableAsserts.assertUserBalances({ account: 'silverstein', symbol: 'GLD', balance: '500.00000000'});
      await assertContractBalance('distribution', 'GLD', '1005.00000000');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:06',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      // console.log(res);
      assert.ok(res.virtualTransactions.length === 0, 'Unexpected virtualTransactions');

      // balance asserts
      await tableAsserts.assertUserBalances({ account: 'rambo', symbol: 'GLD', balance: '500.00000000'});
      await tableAsserts.assertUserBalances({ account: 'silverstein', symbol: 'GLD', balance: '500.00000000'});
      await assertContractBalance('distribution', 'GLD', '1005.00000000');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update stake weight on stake and delegation', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "staker", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "staker2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "delegator", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 1, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 1, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableDelegation', '{ "symbol": "GLD", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableDelegation', '{ "symbol": "SLV", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "10000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-30T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));

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

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];    
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker2', 'tokens', 'stake', '{ "to": "staker2", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker2', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV');
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];    
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker', 'tokens', 'stake', '{ "to": "staker", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'delegator', 'tokens', 'stake', '{ "to": "delegator", "symbol": "SLV", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'delegator', 'tokens', 'delegate', '{ "to": "staker", "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 600);
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];    
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'delegator', 'tokens', 'undelegate', '{ "from": "staker", "symbol": "SLV", "quantity": "50", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 550);
      await assertUserWeight('staker2', 'SLV', 500);
      await assertWeightConsistency(1, 'SLV');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];    
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker', 'tokens', 'unstake', '{ "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker2', 'tokens', 'unstake', '{ "symbol": "SLV", "quantity": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 450);
      await assertUserWeight('staker2', 'SLV', 400);
      await assertWeightConsistency(1, 'SLV');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];    
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker', 'tokenfunds', 'disapproveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'staker2', 'tokenfunds', 'disapproveProposal', '{ "id": "1" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      await assertUserWeight('staker', 'SLV', 450);
      await assertUserWeight('staker2', 'SLV', 400);
      await assertWeightConsistency(1, 'SLV');
      await assertUserApproval('staker', 1, false);
      await assertUserApproval('staker2', 1, false);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should limit max account approvals', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokenfunds', 'updateParams', '{ "maxAccountApprovals": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "GLD", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "SLV", "precision": 8, "maxSupply": "1000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "GLD", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'enableStaking', '{ "symbol": "SLV", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));      
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "10000", "to": "voter2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "SLV", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100000", "to": "voter4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokens', 'issue', '{ "symbol": "GLD", "quantity": "100", "to": "organizer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', '{ "to":"voter1", "symbol": "SLV", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "SLV", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:SLV", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Big Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "800", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'community', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:SLV", "title": "A Small Community Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "500", "authorPermlink": "@abc123/test2", "payout": { "type": "user", "name": "silverstein" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createFund', '{ "payToken": "GLD", "voteToken": "GLD", "voteThreshold": "1000", "maxDays": "365", "maxAmountPerDay": "1000", "proposalFee": { "method": "burn", "symbol": "GLD", "amount": "100" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'setDtfActive', '{ "fundId": "GLD:GLD", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'createProposal', '{ "fundId": "GLD:GLD", "title": "A Big Noble Project", "startDate": "2021-03-14T00:00:00.000Z", "endDate": "2021-04-30T00:00:00.000Z", "amountPerDay": "1000", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "contractPayload": { "id": "1" }, "name": "distribution" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'organizer', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "3" }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      // console.log(res);
      assertError(txs[27], 'you can only approve 2 active proposals');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should establish utility token fund', (done) => {
    new Promise(async (resolve) => {

      await fixture.setUp(); await setUpEnv();

      let refBlockNumber = 56428799;
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(inflationContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(distributionContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, refBlockNumber);
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "donchate", "quantity": "50000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', `{ "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "1000", "to": "voter1", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-12T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      let res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      // utility DTF deployment block
      refBlockNumber = 56977200;
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokens', 'stake', `{ "to": "voter1", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "1000", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-13T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let e = virtualEventLog.events.find(x => x.event === 'createFund');
      assert.ok(e, 'Expected to find createFund event');

      refBlockNumber = 56977201;
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokenfunds', 'createProposal', `{ "fundId": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "title": "Pay Distribution XYZ", "startDate": "2021-03-15T01:00:00.000Z", "endDate": "2022-03-14T00:00:00.000Z", "amountPerDay": "500", "authorPermlink": "@abc123/test", "payout": { "type": "contract", "name": "distribution", "contractPayload": { "distId": "1" } }, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'donchate', 'tokenfunds', 'createProposal', `{ "fundId": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "title": "A Big Community Project", "startDate": "2021-03-15T01:00:00.000Z", "endDate": "2022-03-14T00:00:00.000Z", "amountPerDay": "400", "authorPermlink": "@abc123/test", "payout": { "type": "user", "name": "rambo" }, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "1" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-14T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);      
      await tableAsserts.assertNoErrorInLastBlock();

      refBlockNumber = 56977202;
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'tokenfunds', 'approveProposal', '{ "id": "2" }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2021-03-15T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);      
      res = await fixture.database.getLatestBlockInfo();
      // console.log(res);      

      // await tableAsserts.assertNoErrorInLastBlock();
      assert.ok(res.virtualTransactions.length > 0, 'Expected to find virtualTransactions');
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      e = virtualEventLog.events.find(x => x.event === 'fundProposals');
      assert.ok(e, 'Expected to find fundProposals event');
      assert.equal(e.data.fundId, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}`);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  // END TESTS
});
