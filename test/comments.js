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

const tokensContractPayload = setupContractPayload('tokens', './contracts/tokens.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const witnessContractPayload = setupContractPayload('witnesses', './contracts/witnesses.js');
const commentsContractPayload = setupContractPayload('comments', './contracts/comments.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function setUpRewardPool(configOverride = {}) {
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      const config = { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 14, "downvoteRegenerationDays": 14, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, ...configOverride };
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', `{ "symbol": "TKN", "config": ${JSON.stringify(config)}, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1000", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "10", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "10", "to": "voter2", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
}

describe('comments', function () {
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
  
  it('should create reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));


      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      
      await tableAsserts.assertUserBalances({account: "harpagon", symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "1900.00000000", stake: "0"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      // fee paid
      await tableAsserts.assertUserBalances({account: "harpagon", symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "900.00000000", stake: "0"});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not create reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NOSTAKE", "precision": 8, "maxSupply": "1000000000" }'));


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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "NOTKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": "badconfig", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "none", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "0", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2.1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.001", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": 1.01, "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "none", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.4", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "1.1", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.602", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": 0.6, "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": "7", "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 0, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 31, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": 1.5, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "0.000000001", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "0", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": "5", "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 0, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 31, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": "5", "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 0, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 31, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": "50", "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": -1, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 101, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": "200", "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 0, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 10001, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": "2000" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 0 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 10001 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "NOSTAKE", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      // This one should succeed, triggering double reward pool creation issue
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));

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
      assertError(txs[0], 'operation must be signed with your active key');
      assertError(txs[1], 'token not found');
      assertError(txs[2], 'config invalid');
      assertError(txs[3], 'postRewardCurve should be one of: [power]');
      assertError(txs[4], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[5], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[6], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[7], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[8], 'curationRewardCurve should be one of: [power]');
      assertError(txs[9], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[10], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[11], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[12], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[13], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[14], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[15], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[16], 'rewardPerBlock invalid');
      assertError(txs[17], 'token precision mismatch for rewardPerBlock');
      assertError(txs[18], 'rewardPerBlock invalid');
      assertError(txs[19], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[20], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[21], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[22], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[23], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[24], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[25], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[26], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[27], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[28], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[29], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[30], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[31], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[32], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[33], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[34], 'you must have enough tokens to cover the creation fee');
      // 35 issues BEE to cover fee
      assertError(txs[36], 'must be issuer of token');
      assertError(txs[37], 'token must have staking enabled');
      // 38 successfully creates token, testing for token dupe pools
      assertError(txs[39], 'cannot create multiple reward pools per token');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      await tableAsserts.assertUserBalances({account: "harpagon", symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "900.00000000", stake: "0"});

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.01", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.51", "curationRewardPercentage": 51, "cashoutWindowDays": 8, "rewardPerBlock": "1.6", "voteRegenerationDays": 6, "downvoteRegenerationDays": 6, "stakedRewardPercentage": 51, "votePowerConsumption": 201, "downvotePowerConsumption": 2001 }, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.01","curationRewardCurve":"power","curationRewardCurveParameter":"0.51","curationRewardPercentage":51,"cashoutWindowDays":8,"rewardPerBlock":"1.6","voteRegenerationDays":6,"downvoteRegenerationDays":6,"stakedRewardPercentage":51,"votePowerConsumption":201,"downvotePowerConsumption":2001},"pendingClaims":"0","active":true}');

      // check fee
      await tableAsserts.assertUserBalances({account: "harpagon", symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "800.00000000", stake: "0"});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": "badconfig", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "none", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "0", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2.1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.001", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": 1.01, "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "none", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.4", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "1.1", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.602", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": 0.6, "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": "7", "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 0, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 31, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": 1.5, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "0.000000001", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "0", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": "5", "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 0, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 31, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": "5", "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 0, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 31, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": "50", "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": -1, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 101, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": "200", "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 0, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 10001, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": "2000" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 0 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 10001 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 2, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerBlock": "1.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));

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
      assertError(txs[0], 'operation must be signed with your active key');
      assertError(txs[1], 'config invalid');
      assertError(txs[2], 'postRewardCurve should be one of: [power]');
      assertError(txs[3], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[4], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[5], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[6], 'postRewardCurveParameter should be between "1" and "2" with precision at most 2');
      assertError(txs[7], 'curationRewardCurve should be one of: [power]');
      assertError(txs[8], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[9], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[10], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[11], 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2');
      assertError(txs[12], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[13], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[14], 'cashoutWindowDays should be an integer between 1 and 30');
      assertError(txs[15], 'rewardPerBlock invalid');
      assertError(txs[16], 'token precision mismatch for rewardPerBlock');
      assertError(txs[17], 'rewardPerBlock invalid');
      assertError(txs[18], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[19], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[20], 'voteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[21], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[22], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[23], 'downvoteRegenerationDays should be an integer between 1 and 30');
      assertError(txs[24], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[25], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[26], 'stakedRewardPercentage should be an integer between 0 and 100');
      assertError(txs[27], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[28], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[29], 'votePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[30], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[31], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[32], 'downvotePowerConsumption should be an integer between 1 and 10000');
      assertError(txs[33], 'you must have enough tokens to cover the update fee');
      // 34 issues tokens to cover update fee
      assertError(txs[35], 'must be issuer of token');
      assertError(txs[36], 'reward pool not found');

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should deactivate and reactivate reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":false}');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not deactivate reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 2, "active": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": false, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": false, "isSignedWithActiveKey": true }'));

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
      assertError(txs[0], 'reward pool not found');
      assertError(txs[1], 'operation must be signed with your active key')
      assertError(txs[2], 'must be issuer of token')

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not process reward pool when inactive', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":false}');

      // forward clock, but should not process token
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": false, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      // no issue event
      assert.equal(res.transactions[0].logs, "{}");
      // no newComment event
      assert.equal(res.transactions[1].logs, "{}");
      // no newVote event
      assert.equal(res.transactions[2].logs, "{}");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"0","active":false}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not create comment', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'author1', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1,2,3,4,5,6,7,8,9,10,11] }'));
      // allow to succeed
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      // cannot change config
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [2] }'));

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
      assertError(txs[0], 'action must use comment operation');
      assertError(txs[1], 'rewardPools must have length between 1 and 5');
      assertError(txs[2], 'rewardPools must have length between 1 and 5');
      assertError(txs[3], 'rewardPools must have length between 1 and 5');
      // 4 succeeds
      assertError(txs[5], 'cannot change reward configuration');

      let posts = await fixture.database.find({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1}});
      assert.equal(posts.length, 1);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not vote', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // allow comment to succeed
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'voter1', 'comments', 'vote', '{ "author": "author1", "permlink": "test1", "voter": "voter1", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "author": "author1", "permlink": "test1", "voter": "voter1", "weight": "10" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "author": "author1", "permlink": "test1", "voter": "voter1", "weight": -10001 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "author": "author1", "permlink": "test1", "voter": "voter1", "weight": 10001 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "author": "author1", "permlink": "test2", "voter": "voter1", "weight": 10000 }'));

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
      // 0 is comment op
      assertError(txs[1], 'can only vote with voting op');
      assertError(txs[2], 'weight must be an integer from -10000 to 10000');
      assertError(txs[3], 'weight must be an integer from -10000 to 10000');
      assertError(txs[4], 'weight must be an integer from -10000 to 10000');
      assertError(txs[5], 'post not found');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1"}});
      assert.equal(votes.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays out voted post n^1, curation n^0.5', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"10.0000000000"}}');
      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"10.0000000000","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": 8000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"43200.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527897600000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527897600000,"votingPower":9840,"downvotingPower":10000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43200.00000000","lastRewardTimestamp":1527897600000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"27.1333333333","active":true}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"3184.3704200023"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^b vs 17.8^b - 9.8^b
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"3.1304951684","timestamp":1527897600000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"1.0885094535","timestamp":1527897600000,"voter":"voter2"}]');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"302400.00000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"40878.98223121"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"72764.58837155"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"40878.98223120"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"53991.21658823"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"18773.37178331"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "56821.78530139", stake: "56821.78530137"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "47435.09940972", stake: "47445.09940971"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "9386.68589166", stake: "9396.68589165"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"0","curatorPayoutValue":"40878.98223120","lastPayout":1528502400000,"totalPayoutValue":"81757.96446241"}');
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"0","curatorPayoutValue":"72764.58837155","lastPayout":1528502400000,"totalPayoutValue":"145529.17674310"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"118312.85879449","lastRewardTimestamp":1528502400000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"42.2711111110","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays out voted post n^1.03, curation n^0.7', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.7"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"10.0000000000"}}');
      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"5.0118723362","timestamp":1527811200000,"voter":"voter1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": 8000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"43200.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527897600000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527897600000,"votingPower":9840,"downvotingPower":10000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43200.00000000","lastRewardTimestamp":1527897600000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"29.4066938217","active":true}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"3184.3704200023"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"4.9414937793","timestamp":1527897600000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"2.5625265445","timestamp":1527897600000,"voter":"voter2"}]');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"302400.00000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"40423.55904514"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"73209.45101979"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"40423.55904513"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"48209.36393960"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"25000.08708018"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "56816.50503247", stake: "56816.50503246"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "44316.46149237", stake: "44326.46149236"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "12500.04354009", stake: "12510.04354009"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"0","curatorPayoutValue":"40423.55904513","lastPayout":1528502400000,"totalPayoutValue":"80847.11809027"}');
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"0","curatorPayoutValue":"73209.45101979","lastPayout":1528502400000,"totalPayoutValue":"146418.90203958"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"118333.97987015","lastRewardTimestamp":1528502400000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"45.8046100634","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });


  it('vote past payout is ignored', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "1"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');

      // forward clock past payout time
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // this transaction pays out with maintenance op
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));
      // this vote should be ignored.
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"0.00000000"}}');
      // no record for late vote
      assert.equal(res.transactions[1].logs, "{}");
      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert(vp == null);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('second vote ignores curation', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"10.0000000000"}}');
      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');
      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // update vote with lower value
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 1000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"updateVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"0.9800000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9780,"downvotingPower":10000}');
      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"0.9800000000","scoreTrend":"3182.9400000000"}');
      votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"0.9800000000","curationWeight":"0","timestamp":1527811200000,"voter":"voter1"}]');

      // pay out post
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"302400.00000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"22121.65080058"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"0.00000000"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "11060.82540029", stake: "11060.82540029"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"0.9800000000","scoreTrend":"0","curatorPayoutValue":"22121.65080058","lastPayout":1528416000000,"totalPayoutValue":"44243.30160116"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"258156.69839884","lastRewardTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"6.6941758481","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

 it('successfully downvotes', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.7"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 1000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 2000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"1.0000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[3].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"1.9960000000"}}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"3.0378178077","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.0000000000","voteRshareSum":"1.0000000000","scoreTrend":"3182.9400000000"}');
      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"1.0000000000","curationWeight":"1.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.9960000000","voteRshareSum":"1.9960000000","scoreTrend":"3183.2401605369"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":2000,"rshares":"1.9960000000","curationWeight":"1.6222298031","timestamp":1527811200000,"voter":"voter1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test1", "weight": -1000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newVote')), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"-1.0000000000"}}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527811200000,"votingPower":10000,"downvotingPower":9800}');
      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.0000000000","voteRshareSum":"0.0000000000","scoreTrend":"3182.9400000000"}');
      votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"1.0000000000","curationWeight":"1.0000000000","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":-1000,"rshares":"-1.0000000000","curationWeight":"0","timestamp":1527811200000,"voter":"voter2"}]');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"3.0378178077","active":true}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": -10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"43200.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newVote')), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"-9.8000000000"}}');
      vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527897600000,"votingPower":10000,"downvotingPower":7840}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43200.00000000","lastRewardTimestamp":1527897600000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"2.8352966205","active":true}');

      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.9960000000","voteRshareSum":"-7.8040000000","scoreTrend":"3182.0476827392"}');
      votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":2000,"rshares":"1.9960000000","curationWeight":"1.6222298031","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":-10000,"rshares":"-9.8000000000","curationWeight":"0","timestamp":1527897600000,"voter":"voter2"}]');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"302400.00000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"0.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"0.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"0.00000000"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter2'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"0.00000000"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2'), undefined);

      assert(null === await fixture.database.findOne({ contract: 'tokens', table: 'balances', query: { account: "author1", symbol: "TKN" }}));
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "0", stake: "10.00000000"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.0000000000","voteRshareSum":"0.0000000000","scoreTrend":"0","curatorPayoutValue":"0.00000000","lastPayout":1528502400000,"totalPayoutValue":"0.00000000"}');
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.9960000000","voteRshareSum":"-7.8040000000","scoreTrend":"0","curatorPayoutValue":"0.00000000","lastPayout":1528502400000,"totalPayoutValue":"0.00000000"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"345600.00000000","lastRewardTimestamp":1528502400000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"1.5121581976","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('voting repeatedly decays as expected', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');

      let vp;
      const votingPowerTable = [];
      const votingRsharesTable = [];
      const downvotingPowerTable = [];
      const downvotingRsharesTable = [];
      for (let i = 0; i < 300; i += 1) {
        transactions = [];
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": -10000 }'));
          block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await fixture.sendBlock(block);
        res = await fixture.database.getLatestBlockInfo();
        await tableAsserts.assertNoErrorInLastBlock();
        vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
        votingPowerTable.push(vp.votingPower);
        downvotingPowerTable.push(vp.downvotingPower);
        const voteRshares = JSON.parse(res.transactions[0].logs).events[0].data.rshares;
        const downvoteRshares = JSON.parse(res.transactions[1].logs).events[0].data.rshares;
        votingRsharesTable.push(voteRshares);
        downvotingRsharesTable.push(downvoteRshares);
        if (vp.votingPower === 0 && vp.downvotingPower === 0 && voteRshares === "0.0000000000" && downvoteRshares === "0.0000000000") {
            break;
        }
      }
      assert.equal(votingPowerTable[votingPowerTable.length-1], 0);
      assert.equal(downvotingPowerTable[downvotingPowerTable.length-1], 0);
      assert.equal(votingRsharesTable[votingRsharesTable.length-1], "0.0000000000");
      assert.equal(downvotingRsharesTable[downvotingRsharesTable.length-1], "0.0000000000");
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('create comment with two reward pools', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "ABC", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "ABC", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "ABC", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2", "curationRewardCurve": "power", "curationRewardCurveParameter": "1", "curationRewardPercentage": 75, "cashoutWindowDays": 7, "rewardPerBlock": "0.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 300, "downvotePowerConsumption": 1000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "ABC", "quantity": "1000", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "ABC", "quantity": "50", "to": "voter1", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1,2] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":2,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(evt => evt.data.symbol === "ABC")), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"ABC"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":2,"symbol":"TKN","rshares":"10.0000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(evt => evt.data.symbol === "ABC")), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"ABC","rshares":"50.0000000000"}}');

      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9700,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 2}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":2,"account":"voter1"},"rewardPoolId":2,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerBlock":"0.5","voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000},"pendingClaims":"2500.0000000000","active":true}');
      let rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"50.0000000000","voteRshareSum":"50.0000000000","scoreTrend":"3184.6389700043"}');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","weight":10000,"rshares":"50.0000000000","curationWeight":"50.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":2,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('voting power reflects delegations', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5"});

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "50", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "50", "to": "voter1", "isSignedWithActiveKey": true }'));
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"60.0000000000"}}');

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"67.8415540697","active":true}');
      
      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"60.0000000000","voteRshareSum":"60.0000000000","scoreTrend":"3184.7181512503"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"60.0000000000","curationWeight":"7.7459666924","timestamp":1527811200000,"voter":"voter1"}]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays out maxPostsProcessedPerRound', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.7"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateParams', '{ "maxPostsProcessedPerRound": 1 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let params = await fixture.database.findOne({ contract: 'comments', table: 'params', query: {}});
      assert.equal(params.maxPostsProcessedPerRound, 1);

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events[0]), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"10.0000000000"}}');
      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"5.0118723362","timestamp":1527811200000,"voter":"voter1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": 8000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"43200.00000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527897600000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527897600000,"votingPower":9840,"downvotingPower":10000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      console.log(JSON.stringify(rewardPool));
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43200.00000000","lastRewardTimestamp":1527897600000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"29.4066938217","active":true}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"3184.3704200023"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"4.9414937793","timestamp":1527897600000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"2.5625265445","timestamp":1527897600000,"voter":"voter2"}]');

      // forward clock and then pay out first post
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"302400.00000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"70139.09527086"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"70139.09527085"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2'), undefined);

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "35069.54763543", stake: "35069.54763543"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "35069.54763543", stake: "35079.54763542"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"0","curatorPayoutValue":"70139.09527085","lastPayout":1528502400000,"totalPayoutValue":"140278.19054171"}');
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // not paid out yet
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"3184.3704200023"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"205321.80945829","lastRewardTimestamp":1528502400000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"26.3987630905","active":true}');

      // forward clock and then pay out second post (3 seconds min gap time)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.50000000"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"43494.29056951"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"28641.54906439"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"14852.74150511"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "56816.69292019", stake: "56816.69292018"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "49390.32216763", stake: "49400.32216761"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "7426.37075256", stake: "7436.37075255"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"0","curatorPayoutValue":"70139.09527085","lastPayout":1528502400000,"totalPayoutValue":"140278.19054171"}');
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527897600000,"cashoutTime":1528502400000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000","scoreTrend":"0","curatorPayoutValue":"43494.29056951","lastPayout":1528502403000,"totalPayoutValue":"86988.58113902"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"118334.72831927","lastRewardTimestamp":1528502403000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"45.8045489551","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('processes maintenanceTokensPerAction per action', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "ABC", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "ABC", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "ABC", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2", "curationRewardCurve": "power", "curationRewardCurveParameter": "1", "curationRewardPercentage": 75, "cashoutWindowDays": 6, "rewardPerBlock": "0.5", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 300, "downvotePowerConsumption": 1000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "ABC", "quantity": "1000", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "ABC", "quantity": "50", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateParams', '{ "maintenanceTokensPerAction": 1 }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let params = await fixture.database.findOne({ contract: 'comments', table: 'params', query: {}});
      assert.equal(params.maintenanceTokensPerAction, 1);

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1,2] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":2,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(evt => evt.data.symbol === "ABC")), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"ABC"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(evt => evt.data.symbol === "TKN")), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":2,"symbol":"TKN","rshares":"10.0000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(evt => evt.data.symbol === "ABC")), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"ABC","rshares":"50.0000000000"}}');

      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9700,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 2}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":2,"account":"voter1"},"rewardPoolId":2,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":6,"rewardPerBlock":"0.5","voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000},"pendingClaims":"2500.0000000000","active":true}');
      let rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerBlock":"1.5","voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528329600000,"votePositiveRshareSum":"50.0000000000","voteRshareSum":"50.0000000000","scoreTrend":"3184.6389700043"}');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","scoreTrend":"3183.9400000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","weight":10000,"rshares":"50.0000000000","curationWeight":"50.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":2,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');

      // forward clock and process one token per action
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setActive', '{ "rewardPoolId": 1, "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'ABC')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"ABC","quantity":"115200.00000000"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'TKN'), undefined);
      assert.equal(JSON.parse(res.transactions[1].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'ABC'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'TKN')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"345600.00000000"}}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
