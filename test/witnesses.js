/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert').strict;
const { MongoClient } = require('mongodb');
const dhive = require('@hiveio/dhive');
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');

// Will replace contract locally.
const NB_WITNESSES = 5;

const signPayload = (signingKey, payload, isPayloadSHA256 = false) => {
  let payloadHash;
  if (isPayloadSHA256 === true) {
    payloadHash = payload;
  } else {
    payloadHash = typeof payload === 'string'
      ? SHA256(payload).toString(enchex)
      : SHA256(JSON.stringify(payload)).toString(enchex);
  }

  const buffer = Buffer.from(payloadHash, 'hex');

  return signingKey.sign(buffer).toString();
};

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const tokenfundsContractPayload = setupContractPayload('tokenfunds', './contracts/tokenfunds.js');
const nftauctionContractPayload = setupContractPayload('nftauction', './contracts/nftauction.js');
const witnessesContractPayload = setupContractPayload('witnesses', './contracts/witnesses.js',
    (contractCode) => contractCode.replace(/NB_TOP_WITNESSES = .*;/, 'NB_TOP_WITNESSES = 4;').replace(/MAX_ROUND_PROPOSITION_WAITING_PERIOD = .*;/, 'MAX_ROUND_PROPOSITION_WAITING_PERIOD = 20;').replace(/NB_WITNESSES_SIGNATURES_REQUIRED = .*;/, 'NB_WITNESSES_SIGNATURES_REQUIRED = 3;'));

function addGovernanceTokenTransactions(fixture, transactions, blockNumber) {
    transactions.push(new Transaction(blockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', `{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "precision": 5, "maxSupply": "10000000", "isSignedWithActiveKey": true }`));
    transactions.push(new Transaction(blockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', `{ "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "unstakingCooldown": 40, "numberTransactions": 4, "isSignedWithActiveKey": true }`));
    transactions.push(new Transaction(blockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', `{ "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "undelegationCooldown": 7, "isSignedWithActiveKey": true }`));
    transactions.push(new Transaction(blockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', `{ "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "quantity": "1500000", "isSignedWithActiveKey": true }`));
}

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

describe('witnesses', function () {
  this.timeout(60000);

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
  
  it('registers witnesses', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), 'dan', 'witnesses', 'register', `{ "IP": "123.255.123.254", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), 'vitalik', 'witnesses', 'register', `{ "IP": "123.255.123.253", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 37899120,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      let witnesses = res;

      assert.equal(witnesses[0].account, 'dan');
      assert.equal(witnesses[0].IP, "123.255.123.254");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[0].RPCPort, 5000);
      assert.equal(witnesses[0].P2PPort, 6000);
      assert.equal(witnesses[0].signingKey, 'STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR');
      assert.equal(witnesses[0].enabled, true);

      assert.equal(witnesses[1].account, 'vitalik');
      assert.equal(witnesses[1].IP, "123.255.123.253");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[1].RPCPort, 7000);
      assert.equal(witnesses[1].P2PPort, 8000);
      assert.equal(witnesses[1].signingKey, 'STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq');
      assert.equal(witnesses[1].enabled, false);

      transactions = [];

      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'dan', 'witnesses', 'register', `{ "IP": "123.255.123.123", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'vitalik', 'witnesses', 'register', `{ "IP": "123.255.123.124", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": true, "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899121,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, 'dan');
      assert.equal(witnesses[0].IP, "123.255.123.123");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[0].RPCPort, 5000);
      assert.equal(witnesses[0].P2PPort, 6000);
      assert.equal(witnesses[0].signingKey, 'STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR');
      assert.equal(witnesses[0].enabled, false);

      assert.equal(witnesses[1].account, 'vitalik');
      assert.equal(witnesses[1].IP, "123.255.123.124");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[1].RPCPort, 7000);
      assert.equal(witnesses[1].P2PPort, 8000);
      assert.equal(witnesses[1].signingKey, 'STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq');
      assert.equal(witnesses[1].enabled, true);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('approves witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let transactions = [];
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899125, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899125, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.234", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
      addGovernanceTokenTransactions(fixture, transactions, 32713425);
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713425, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 32713425,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      let witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000");

      res = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: CONSTANTS.HIVE_ENGINE_ACCOUNT
          }
        });

      let account = res;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight, "100.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      let approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      let params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00000");

      transactions = [];
      transactions.push(new Transaction(32713426, fixture.getNextTxId(), 'satoshi', 'witnesses', 'register', `{ "IP": "123.234.123.245", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pJ", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713426, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "0.00001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713426, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713426, fixture.getNextTxId(), 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(32713426, fixture.getNextTxId(), 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899120,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      let accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight, "100.00000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 2);
      assert.equal(accounts[1].approvalWeight, "0.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[2].to, "satoshi");

      assert.equal(approvals[3].from, "ned");
      assert.equal(approvals[3].to, "dan");

      assert.equal(approvals[4].from, "ned");
      assert.equal(approvals[4].to, "satoshi");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight, "300.00002");

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('disapproves witnesses', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.232", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
      addGovernanceTokenTransactions(fixture, transactions, 37899121);
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'satoshi', 'witnesses', 'register', `{ "IP": "123.234.123.231", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pJ", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "0.00001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899121, fixture.getNextTxId(), 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 37899121,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      transactions = [];
      transactions.push(new Transaction(37899122, fixture.getNextTxId(), 'ned', 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899122,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      let accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight, "100.00000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "satoshi");
      assert.equal(approvals.length, 1);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight, "300.00001");

      transactions = [];
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899123,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "0.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        });

      approvals = res;

      assert.equal(approvals.length, 0);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00001");

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('updates witnesses approvals when staking, unstaking, delegating and undelegating the utility token', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();

      let transactions = [];
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.234", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
      addGovernanceTokenTransactions(fixture, transactions, 37899123);
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899123, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "0.00001", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 37899123,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      let witnesses = res;
      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: CONSTANTS.HIVE_ENGINE_ACCOUNT
          }
        });

      let account = res;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      let approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      let params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00002");

      transactions = [];
      transactions.push(new Transaction(37899124, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "1", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899124,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      let accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000");

      transactions = [];
      transactions.push(new Transaction(37899125, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'delegate', `{ "to": "ned", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "2", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899125,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "98.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "98.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "3.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "199.00002");

      transactions = [];
      transactions.push(new Transaction(37899126, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'undelegate', `{ "from": "ned", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "2", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899126,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
          }
        });

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '99.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "98.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "98.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "197.00002");

      transactions = [];
      transactions.push(new Transaction(37899127, fixture.getNextTxId(), 'harpagon', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 37899127,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-08-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "201.00002");

      transactions = [];
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), 'ned', 'tokens', 'unstake', `{ "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "1", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: 37899128,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-08-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.75001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.75000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.75002");

      transactions = [];
      transactions.push(new Transaction(37899129, fixture.getNextTxId(), 'harpagon', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: 37899129,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-10-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        });

      witnesses = res;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.25001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00001");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        });

      accounts = res;

      assert.equal(accounts[0].account, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.25000");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        });

      approvals = res;

      assert.equal(approvals[0].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        });

      params = res;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.25002");
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('schedules witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();
      let transactions = [];
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, 37899128);
      transactions.push(new Transaction(37899128, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        const witnessAccount = `witness${index}`;
        const wif = dhive.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(37899128, fixture.getNextTxId(), witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${index}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic('TST').toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refHiveBlockNumber: 37899128,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      transactions = [];
      for (let index = 0; index < 30; index++) {
        transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refHiveBlockNumber: 99999999,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      let res = await fixture.database.find({
          contract: 'witnesses',
          table: 'schedules',
          query: {
            
          }
        });

      let schedule = res;

      assert.equal(schedule[0].witness, "witness34");
      assert.equal(schedule[0].blockNumber, 2);
      assert.equal(schedule[0].round, 1);

      assert.equal(schedule[1].witness, "witness33");
      assert.equal(schedule[1].blockNumber, 3);
      assert.equal(schedule[1].round, 1);

      assert.equal(schedule[2].witness, "witness27");
      assert.equal(schedule[2].blockNumber, 4);
      assert.equal(schedule[2].round, 1);

      assert.equal(schedule[3].witness, "witness31");
      assert.equal(schedule[3].blockNumber, 5);
      assert.equal(schedule[3].round, 1);

      assert.equal(schedule[4].witness, "witness32");
      assert.equal(schedule[4].blockNumber, 6);
      assert.equal(schedule[4].round, 1);

      res = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        });

      let params = res;

      assert.equal(params.totalApprovalWeight, '3000.00000');
      assert.equal(params.numberOfApprovedWitnesses, 30);
      assert.equal(params.lastVerifiedBlockNumber, 1);
      assert.equal(params.currentWitness, 'witness32');
      assert.equal(params.lastWitnesses.includes('witness32'), true);
      assert.equal(params.round, 1);
      assert.equal(params.lastBlockRound, 6);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('verifies a block with liquid pay', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();
      let transactions = [];
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, 37899120);
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), 'null', 'tokens', 'issueToContract', `{ "to": "witnesses", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "1000", "isSignedWithActiveKey": true, "callingContractInfo": { "name": "mining" } }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        const witnessAccount = `witness${index}`;
        const wif = dhive.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(37899120, fixture.getNextTxId(), witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${index}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic().toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refHiveBlockNumber: 37899120,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      transactions = [];
      for (let index = 0; index < 30; index++) {
        transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refHiveBlockNumber: 99999999,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      for (let i = 1; i < NB_WITNESSES; i++) {
        transactions = [];
        // send whatever transaction;
        transactions.push(new Transaction(100000000 + i, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refHiveBlockNumber: 100000000 + i,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: `2018-06-01T00:00:0${i}`,
          transactions,
        };

        await fixture.sendBlock(block);
      }

      // Change witnesses number mid block, which will reset the schedule.
      transactions = [];
      transactions.push(new Transaction(100000005, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'updateParams', '{"numberOfTopWitnesses": 20, "numberOfWitnessSlots": 21, "witnessSignaturesRequired": 14}'));
      block = {
        refHiveBlockNumber: 100000005,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:05',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

      assert.equal(params.numberOfWitnessSlots, 21);
      assert.equal(params.witnessSignaturesRequired, 14);

      // generate enough blocks to get to 21
      for (let i = NB_WITNESSES + 1; i < 21; i++) {
        transactions = [];
        // send whatever transaction;
        transactions.push(new Transaction(100000000 + i, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refHiveBlockNumber: 100000000 + i,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: `2018-06-01T00:00:0${i}`,
          transactions,
        };

        await fixture.sendBlock(block);
      }

      let blockNum = params.lastVerifiedBlockNumber + 1;
      let endBlockRound = params.lastBlockRound;

      let calculatedRoundHash = '';
      // calculate round hash
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await fixture.database.getBlockInfo(blockNum);

        const blockFromNode = queryRes;
        if (blockFromNode !== null) {
          calculatedRoundHash = SHA256(`${calculatedRoundHash}${blockFromNode.hash}`).toString(enchex);
        }
        blockNum += 1;
      }
      
      res = await fixture.database.find({
          contract: 'witnesses',
          table: 'schedules',
          query: {
            
          }
        });

      let schedules = res;
      assert(schedules.length > 0);

      let signatures = [];
      schedules.forEach(schedule => {
        const wif = dhive.PrivateKey.fromLogin(schedule.witness, 'testnet', 'active');
        const sig = signPayload(wif, calculatedRoundHash, true)
        signatures.push([schedule.witness, sig])
      });

      let json = {
        round: 2,
        roundHash: calculatedRoundHash,
        signatures,
        isSignedWithActiveKey: true,
      };

      transactions = [];
      transactions.push(new Transaction(110000000, fixture.getNextTxId(), params.currentWitness, 'witnesses', 'proposeRound', JSON.stringify(json)));

      block = {
        refHiveBlockNumber: 110000000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:11',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      blockNum = params.lastVerifiedBlockNumber + 1;

      // check if the blocks are now marked as verified
      let i = 0;
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await fixture.database.getBlockInfo(blockNum);

        const blockFromNode = queryRes;
        const wif = dhive.PrivateKey.fromLogin(blockFromNode.witness, 'testnet', 'active');
        assert.equal(blockFromNode.round, 2);
        assert.equal(blockFromNode.witness, schedules[schedules.length - 1].witness);
        assert.equal(blockFromNode.roundHash, calculatedRoundHash);
        assert.equal(blockFromNode.signingKey, wif.createPublic().toString());
        assert.equal(blockFromNode.roundSignature, signatures[signatures.length - 1][1]);
        blockNum += 1;
        i +=1;
      }

      for (i = 0; i < schedules.length; i += 1) {
        await tableAsserts.assertUserBalances({ account: schedules[i].witness, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "0.00951293", stake: "0"});
      }

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('generates a new schedule once the current one is completed', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, refBlockNumber);
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        const witnessAccount = `witness${index}`;
        const wif = dhive.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${index}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic().toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      for (let index = 0; index < 30; index++) {
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      for (let i = 1; i < NB_WITNESSES; i++) {
        transactions = [];
        // send whatever transaction;
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: `ABCD1234`,
          prevRefHiveBlockId: `ABCD1233`,
          timestamp: `2018-06-01T00:00:0${i}`,
          transactions,
        };

        await fixture.sendBlock(block);
      } 

      let params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

        console.log(params);

      let blockNum = params.lastVerifiedBlockNumber + 1;
      const endBlockRound = params.lastBlockRound;

      let calculatedRoundHash = '';
      // calculate round hash
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await fixture.database.getBlockInfo(blockNum);

        const blockFromNode = queryRes;
        if (blockFromNode !== null) {
          calculatedRoundHash = SHA256(`${calculatedRoundHash}${blockFromNode.hash}`).toString(enchex);
        }
        blockNum += 1;
      }
      
      const schedule = await fixture.database.find({
          contract: 'witnesses',
          table: 'schedules',
          query: {}
        });

      const signatures = [];
      schedule.forEach(scheduleItem => {
        const wif = dhive.PrivateKey.fromLogin(scheduleItem.witness, 'testnet', 'active');
        const sig = signPayload(wif, calculatedRoundHash, true)
        signatures.push([scheduleItem.witness, sig])
      });

      const json = {
        round: 1,
        roundHash: calculatedRoundHash,
        signatures,
        isSignedWithActiveKey: true,
      };
        console.log(json);

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), params.currentWitness, 'witnesses', 'proposeRound', JSON.stringify(json)));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      const newSchedule = await fixture.database.find({
          contract: 'witnesses',
          table: 'schedules',
          query: {}
        });

      assert.equal(newSchedule.length, schedule.length);
      for (let i = 0; i < newSchedule.length; i += 1) {
        assert.equal(newSchedule[i].blockNumber, schedule.length + 2 + i);
        assert.equal(newSchedule[i].round, 2);
      }
      assert(newSchedule[0].witness !== schedule[schedule.length - 1].witness);

      params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

      assert.equal(params.totalApprovalWeight, '3000.00000');
      assert.equal(params.numberOfApprovedWitnesses, 30);
      assert.equal(params.lastVerifiedBlockNumber, 6);
      assert.equal(params.currentWitness, newSchedule[newSchedule.length - 1].witness);
      assert(params.lastWitnesses.includes(newSchedule[newSchedule.length - 1].witness));
      assert.equal(params.round, 2);
      assert.equal(params.lastBlockRound, 11);
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('changes the current witness if it has not validated a round in time', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();
      let transactions = [];
      transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(37899120, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, 37899120);
      transactions.push(new Transaction(99999999, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        const witnessAccount = `witness${index}`;
        const wif = dhive.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(99999999, fixture.getNextTxId(), witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${index}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic('TST').toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refHiveBlockNumber: 99999999,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      transactions = [];
      for (let index = 0; index < 30; index++) {
        transactions.push(new Transaction(100000000, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refHiveBlockNumber: 100000000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        });

      let params = res;

      assert.equal(params.totalApprovalWeight, '3000.00000');
      assert.equal(params.numberOfApprovedWitnesses, 30);
      assert.equal(params.lastVerifiedBlockNumber, 1);
      assert.equal(params.currentWitness, 'witness33');
      assert.equal(params.lastWitnesses.includes('witness33'), true);
      assert.equal(params.round, 1);
      assert.equal(params.lastBlockRound, 6);

      // generate 20 blocks
      for (let index = 30; index < 51; index++) {
        transactions = [];
        transactions.push(new Transaction(100000001 + index, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

        block = {
          refHiveBlockNumber: 100000001 + index,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-07-14T00:02:00',
          transactions,
        };

        await fixture.sendBlock(block);
      }

        res = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        });

      params = res;

      assert.equal(JSON.stringify(params), '{"_id":1,"totalApprovalWeight":"3000.00000","numberOfApprovedWitnesses":30,"lastVerifiedBlockNumber":1,"round":1,"lastBlockRound":6,"currentWitness":"witness29","blockNumberWitnessChange":42,"lastWitnesses":["witness33","witness29"],"numberOfApprovalsPerAccount":30,"numberOfTopWitnesses":4,"numberOfWitnessSlots":5,"witnessSignaturesRequired":3,"maxRoundsMissedInARow":3,"maxRoundPropositionWaitingPeriod":20}');

      let schedule = await fixture.database.find({
          contract: 'witnesses',
          table: 'schedules',
          query: {}
      });

      assert.equal(JSON.stringify(schedule), '[{"_id":1,"witness":"witness31","blockNumber":2,"round":1},{"_id":2,"witness":"witness32","blockNumber":3,"round":1},{"_id":3,"witness":"witness30","blockNumber":4,"round":1},{"_id":4,"witness":"witness34","blockNumber":5,"round":1},{"_id":5,"witness":"witness29","blockNumber":6,"round":1}]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('update params', (done) => {
    new Promise(async (resolve) => {
      
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(nftauctionContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessesContractPayload)));
      addGovernanceTokenTransactions(fixture, transactions, refBlockNumber);
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'stake', `{ "to": "${CONSTANTS.HIVE_ENGINE_ACCOUNT}", "symbol": "${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

      assert.equal(JSON.stringify(params), '{"_id":1,"totalApprovalWeight":"0","numberOfApprovedWitnesses":0,"lastVerifiedBlockNumber":0,"round":0,"lastBlockRound":0,"currentWitness":null,"blockNumberWitnessChange":0,"lastWitnesses":[],"numberOfApprovalsPerAccount":30,"numberOfTopWitnesses":4,"numberOfWitnessSlots":5,"witnessSignaturesRequired":3,"maxRoundsMissedInARow":3,"maxRoundPropositionWaitingPeriod":20}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'updateParams', '{"totalApprovalWeight":"1","numberOfApprovedWitnesses":1,"lastVerifiedBlockNumber":1,"round":1,"lastBlockRound":1,"currentWitness":"ignore","blockNumberWitnessChange":1,"lastWitnesses":["ignore"],"maxRoundPropositionWaitingPeriod":21,"maxRoundsMissedInARow":4,"numberOfApprovalsPerAccount":31,"numberOfTopWitnesses":5,"numberOfWitnessSlots":6,"witnessSignaturesRequired":16}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

      const paramsString = '{"_id":1,"totalApprovalWeight":"0","numberOfApprovedWitnesses":0,"lastVerifiedBlockNumber":0,"round":0,"lastBlockRound":0,"currentWitness":null,"blockNumberWitnessChange":0,"lastWitnesses":[],"numberOfApprovalsPerAccount":31,"numberOfTopWitnesses":5,"numberOfWitnessSlots":6,"witnessSignaturesRequired":16,"maxRoundsMissedInARow":4,"maxRoundPropositionWaitingPeriod":21}';
      assert.equal(JSON.stringify(params), paramsString);

      // Verify 1 backup witness condition in setting
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'witnesses', 'updateParams', '{"totalApprovalWeight":"2","numberOfApprovedWitnesses":2,"lastVerifiedBlockNumber":2,"round":2,"lastBlockRound":2,"currentWitness":"ignore","blockNumberWitnessChange":2,"lastWitnesses":["ignore"],"maxRoundPropositionWaitingPeriod":22,"maxRoundsMissedInARow":5,"numberOfApprovalsPerAccount":32,"numberOfTopWitnesses":6,"numberOfWitnessSlots":6,"witnessSignaturesRequired":17}'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;
      assertError(txs[0], 'only 1 backup allowed');

      params = await fixture.database.findOne({
          contract: 'witnesses',
          table: 'params',
          query: {}
        });

      // unchanged from above
      assert.equal(JSON.stringify(params), paramsString);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

});
