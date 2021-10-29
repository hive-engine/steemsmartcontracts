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
const tokenfundsContractPayload = setupContractPayload('tokenfunds', './contracts/tokenfunds.js');
const miningContractPayload = setupContractPayload('mining', './contracts/mining.js');
const witnessContractPayload = setupContractPayload('witnesses', './contracts/witnesses.js');
const commentsContractPayload = setupContractPayload('comments', './contracts/comments.js', (contractCode) => contractCode.replace(/POST_QUERY_LIMIT = .*;/, 'POST_QUERY_LIMIT = 1;'));

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function setUpRewardPool(configOverride = {}) {
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(witnessContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      const config = { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 14, "downvoteRegenerationDays": 14, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": ["scottest"], ...configOverride };
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', `{ "symbol": "TKN", "config": ${JSON.stringify(config)}, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1000", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "10", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "10", "to": "voter2", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
}

function maintenanceOp(refBlockNumber) {
    return new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "null", "author": "null", "permlink": "test", "weight": 10000 }');
}

async function forwardPostMaintenanceAndAssertIssue(timestamp, tokens) {
  let transactions, refBlockNumber, block, res, rewardPool;
  let tokensIssued = BigNumber(0);
  let verifyNumBlocks = 10;
  const initialRewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
  let simulatedPendingClaims = initialRewardPool.pendingClaims;
  const timestampMillis = new Date(`${timestamp}.000Z`).getTime();
  const initialTokensContractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { account: 'comments', symbol: 'TKN'}});
  for (let i = 0; i < verifyNumBlocks; i += 1) {
    transactions = [];
    refBlockNumber = fixture.getNextRefBlockNumber();
    transactions.push(maintenanceOp(refBlockNumber));
    block = {
      refHiveBlockNumber: refBlockNumber,
      refHiveBlockId: 'ABCD1',
      prevRefHiveBlockId: 'ABCD2',
      timestamp,
      transactions,
    };

    await fixture.sendBlock(block);
    res = await fixture.database.getLatestBlockInfo();
    await tableAsserts.assertNoErrorInLastBlock();
    if (res.transactions) {
      res.transactions.forEach(t => {
        const logs = JSON.parse(t.logs);
        if (logs) {
          const events = logs.events;
          if (events) {
            const issueContractEvent = events.find(ev => ev.event === 'issueToContract');
            if (issueContractEvent) {
              tokensIssued = tokensIssued.plus(issueContractEvent.data.quantity);
            }
          }
        }
      });
    }

    simulatedPendingClaims = BigNumber(simulatedPendingClaims).multipliedBy(1 - 3.0 / (15*24*3600)).toFixed(10, BigNumber.ROUND_DOWN);

    rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
    if (rewardPool.lastClaimDecayTimestamp >= timestampMillis) {
      break;
    }
  }

  const totalAdded = BigNumber(rewardPool.config.rewardPerInterval).times(10);
  assert.equal(tokensIssued.toFixed(), totalAdded.toFixed());
  assert.equal(rewardPool.rewardPool, totalAdded.plus(initialRewardPool.rewardPool).toFixed(8));
  assert.equal(rewardPool.pendingClaims, simulatedPendingClaims);
  const tokensContractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { account: 'comments', symbol: 'TKN'}});
  assert.equal(tokensContractBalance.balance, totalAdded.plus(initialTokensContractBalance ? initialTokensContractBalance.balance : 0).toFixed(8));

  // fast forward chain (make sure contract has enough also)
  rewardPool.lastClaimDecayTimestamp = timestampMillis;
  rewardPool.lastRewardTimestamp = timestampMillis;
  rewardPool.rewardPool = tokens;
  await fixture.database.update({ contract: 'comments', table: 'rewardPools', record: rewardPool });
  tokensContractBalance.balance = tokens;
  await fixture.database.update({ contract: 'tokens', table: 'contractsBalances', record: tokensContractBalance });
}

async function runBeneficiaryTest(options) {
  await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "1"});

  let transactions;
  let refBlockNumber;
  let block;

  transactions = [];
  refBlockNumber = fixture.getNextRefBlockNumber();
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'commentOptions', '{ "author": "author1", "permlink": "test1", "maxAcceptedPayout": "1000000.000 HBD", "beneficiaries": [{"account": "bene1", "weight": 5000}, {"account": "bene2", "weight": 1}]}'));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));
  if (options.muteAll) {
    transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "author1", "mute": true, "isSignedWithActiveKey": true }'));
    transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "voter1", "mute": true, "isSignedWithActiveKey": true }'));
    transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "bene1", "mute": true, "isSignedWithActiveKey": true }'));
  }
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "voter2", "mute": true, "isSignedWithActiveKey": true }'));
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test1", "weight": 10000 }'));

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
  assert.equal(JSON.stringify(JSON.parse(res.transactions.find(t => JSON.parse(t.payload).voter === 'voter2').logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"0","mute":true}}');
  const mutedVote = await fixture.database.findOne({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: '@author1/test1', voter: 'voter2' }});
  assert.equal(JSON.stringify(mutedVote), '{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"0","curationWeight":"0","timestamp":1527811200000,"voter":"voter2"}');

  let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
  assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","beneficiaries":[{"account":"bene1","weight":5000},{"account":"bene2","weight":1}],"declinePayout":false}');

  // catch up post maintenance
  await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");
  rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
  assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"9.9997685205","active":true,"intervalPendingClaims":"9.9997685205","intervalRewardPool":"15.00000000"}');

  // forward clock past payout time
  transactions = [];
  refBlockNumber = fixture.getNextRefBlockNumber();
  // this transaction pays out with maintenance op
  transactions.push(maintenanceOp(refBlockNumber));

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

  addMute = (rewardLog) => {
      if (options.muteAll) {
          rewardLog.data.mute = true;
      }
      return JSON.stringify(rewardLog);
  };
  assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), addMute({"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"37792.92115529"}}));
  assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'beneficiaryReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'bene1')), addMute({"contract":"comments","event":"beneficiaryReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"bene1","quantity":"37800.48125153"}}));
  assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'beneficiaryReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'bene2')), '{"contract":"comments","event":"beneficiaryReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"bene2","quantity":"7.56009625"}}');
  assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), addMute({"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"75600.96250306"}}));
  assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter2'), undefined);

  post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
  assert.equal(post, null);

  const balanceForMute = (bal) => {
      if (options.muteAll) {
          if (bal.account === 'voter1') {
              bal.balance = '0';
              bal.stake = '10.00000000';
          } else {
              bal.balance = null;
              bal.stake = null;
          }
      }
      return bal;
  }
  await tableAsserts.assertUserBalances(balanceForMute({account: "author1", symbol: "TKN", balance: "18896.46057765", stake: "18896.46057764"}));
  await tableAsserts.assertUserBalances(balanceForMute({account: "bene1", symbol: "TKN", balance: "18900.24062577", stake: "18900.24062576"}));
  await tableAsserts.assertUserBalances({account: "bene2", symbol: "TKN", balance: "3.78004813", stake: "3.78004812"});
  await tableAsserts.assertUserBalances(balanceForMute({account: "voter1", symbol: "TKN", balance: "37800.48125153", stake: "37810.48125153"}));
  await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: '0', stake: '10.00000000'});
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags":["scottest"]}, "isSignedWithActiveKey": true }'));

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

      const hiveEngineBeeBalance = await fixture.database.findOne({
        contract: 'tokens',
        table: 'balances',
        query: {
          account: CONSTANTS.HIVE_ENGINE_ACCOUNT,
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
        },
      });

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'createRewardPool', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags":["scottest"]}, "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      // fee not paid
      await tableAsserts.assertUserBalances({account: CONSTANTS.HIVE_ENGINE_ACCOUNT, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: hiveEngineBeeBalance.balance, stake: "0"});

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "NOTKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": "badconfig", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "none", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "0", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2.1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.001", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": 1.01, "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "none", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.4", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "1.1", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.602", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": 0.6, "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": "7", "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 0, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 31, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": 1.5, "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "0.000000001", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "0", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": "5", "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 0, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 31, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": "5", "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 0, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 31, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": "50", "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": -1, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 101, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": "200", "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 0, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 10001, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": "2000" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 0 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 10001 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "NOSTAKE", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": "invalid" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [1] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["1", "2", "3", "4", "5", "6"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": "3", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 2, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 100000, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      // This one should succeed, triggering double reward pool creation issue
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "TKN", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000,"tags":["scottest"] }, "isSignedWithActiveKey": true }'));

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
      assertError(txs[16], 'rewardPerInterval invalid');
      assertError(txs[17], 'token precision mismatch for rewardPerInterval');
      assertError(txs[18], 'rewardPerInterval invalid');
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
      assertError(txs[38], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[39], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[40], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[41], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[42], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      assertError(txs[43], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      assertError(txs[44], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      // 45 successfully creates token, testing for token dupe pools
      assertError(txs[46], 'cannot create multiple reward pools per token');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'createRewardPool', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags":["scottest"]}, "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();


      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateParams', '{ "updateFee": "100" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.01", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.51", "curationRewardPercentage": 51, "cashoutWindowDays": 8, "rewardPerInterval": "1.6", "rewardIntervalSeconds": 3, "voteRegenerationDays": 6, "downvoteRegenerationDays": 6, "stakedRewardPercentage": 51, "votePowerConsumption": 201, "downvotePowerConsumption": 2001, "tags": ["scottest2"]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.01","curationRewardCurve":"power","curationRewardCurveParameter":"0.51","curationRewardPercentage":51,"cashoutWindowDays":8,"rewardPerInterval":"1.6","rewardIntervalSeconds":3,"voteRegenerationDays":6,"downvoteRegenerationDays":6,"stakedRewardPercentage":51,"votePowerConsumption":201,"downvotePowerConsumption":2001,"tags":["scottest2"]},"pendingClaims":"0","active":true}');

      // check fee
      await tableAsserts.assertUserBalances({account: "harpagon", symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: "800.00000000", stake: "0"});

      const hiveEngineBeeBalance = await fixture.database.findOne({
        contract: 'tokens',
        table: 'balances',
        query: {
          account: CONSTANTS.HIVE_ENGINE_ACCOUNT,
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
        },
      });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateRewardPool', '{ "rewardPoolId": 2, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.01", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.51", "curationRewardPercentage": 51, "cashoutWindowDays": 8, "rewardPerInterval": "1.6", "rewardIntervalSeconds": 3, "voteRegenerationDays": 6, "downvoteRegenerationDays": 6, "stakedRewardPercentage": 51, "votePowerConsumption": 201, "downvotePowerConsumption": 2001, "tags": ["scottest2"]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":2,"symbol":"BEE","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.01","curationRewardCurve":"power","curationRewardCurveParameter":"0.51","curationRewardPercentage":51,"cashoutWindowDays":8,"rewardPerInterval":"1.6","rewardIntervalSeconds":3,"voteRegenerationDays":6,"downvoteRegenerationDays":6,"stakedRewardPercentage":51,"votePowerConsumption":201,"downvotePowerConsumption":2001,"tags":["scottest2"]},"pendingClaims":"0","active":true}');

      // check no fee
      await tableAsserts.assertUserBalances({account: CONSTANTS.HIVE_ENGINE_ACCOUNT, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, balance: hiveEngineBeeBalance.balance, stake: "0"});

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": "badconfig", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "none", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "0", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2.1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1.001", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": 1.01, "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "none", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.4", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "1.1", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.602", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": 0.6, "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": "7", "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 0, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 31, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": 1.5, "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "0.000000001", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "0", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": "5", "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 0, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 31, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": "5", "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 0, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 31, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": "50", "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": -1, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 101, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": "200", "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 0, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 10001, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": "2000", "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 0, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 10001, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000 }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": "invalid" }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ 1 ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "1", "2", "3", "4", "5", "6" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": "3", "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "1" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 2, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "1" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 100000, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "1" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'comments', 'updateRewardPool', '{ "rewardPoolId": 1, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'updateRewardPool', '{ "rewardPoolId": 2, "config": { "postRewardCurve": "power", "postRewardCurveParameter": "1", "curationRewardCurve": "power", "curationRewardCurveParameter": "0.5", "curationRewardPercentage": 50, "cashoutWindowDays": 7, "rewardPerInterval": "1.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 200, "downvotePowerConsumption": 2000, "tags": [ "scottest" ] }, "isSignedWithActiveKey": true }'));

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
      assertError(txs[15], 'rewardPerInterval invalid');
      assertError(txs[16], 'token precision mismatch for rewardPerInterval');
      assertError(txs[17], 'rewardPerInterval invalid');
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
      assertError(txs[33], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[34], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[35], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[36], 'tags should be a non-empty array of strings of length at most 5');
      assertError(txs[37], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      assertError(txs[38], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      assertError(txs[39], 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3');
      assertError(txs[40], 'you must have enough tokens to cover the update fee');
      // 41 issues tokens to cover update fee
      assertError(txs[42], 'must be issuer of token');
      assertError(txs[43], 'reward pool not found');

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":true}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not setMute', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "author", "mute": true, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 2, "account": "author", "mute": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "-invalid", "mute": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "author", "mute": "invalid", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "author", "isSignedWithActiveKey": true }'));

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
      assertError(txs[1], 'reward pool not found');
      assertError(txs[2], 'invalid account');
      assertError(txs[3], 'mute must be a boolean');
      assertError(txs[4], 'mute must be a boolean');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should setMute', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'setMute', '{ "rewardPoolId": 1, "account": "author", "mute": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      const vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'author', rewardPoolId: 1}});
      assert(vp.mute);

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":false}');

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":true}');

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":true}');

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":false}');

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":false}');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": ["2"] }'));

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
      assertError(txs[1], 'rewardPools must be an array of integers');
      assertError(txs[2], 'rewardPools must be an array of integers');

      const posts = await fixture.database.find({ contract: 'comments', table: 'posts', query: {}});
      assert.equal(posts.length, 0);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not reactivate comment after payout', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "0.5"});

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

      let posts = await fixture.database.find({ contract: 'comments', table: 'posts', query: {}});
      assert.equal(JSON.stringify(posts), '[{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"0","voteRshareSum":"0"}]');
      let postMetadata = await fixture.database.findOne({ contract: 'comments', table: 'postMetadata', query: { authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(postMetadata), '{"_id":{"authorperm":"@author1/test1"},"authorperm":"@author1/test1","rewardPoolIds":[1]}');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");

      // forward clock and then pay out post
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      posts = await fixture.database.find({ contract: 'comments', table: 'posts', query: {}});
      assert.equal(JSON.stringify(posts), '[]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      posts = await fixture.database.find({ contract: 'comments', table: 'posts', query: {}});
      assert.equal(JSON.stringify(posts), '[]');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "author1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.0000000000","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"author1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"0.0000000000","curationWeight":"0.0000000000","timestamp":1527811200000,"voter":"author1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": 8000 }'));

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
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527811200000,"votingPower":9840,"downvotingPower":10000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"27.8000000000","active":true}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^b vs 17.8^b - 9.8^b
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"3.1304951684","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"1.0885094535","timestamp":1527811200000,"voter":"voter2"}]');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"27.7993564875","active":true,"intervalPendingClaims":"27.7993564875","intervalRewardPool":"15.00000000"}');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"27194.59082809"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"48406.37167400"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"27194.59082809"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'author1')), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"35917.45594651"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"12488.91572748"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "37800.48125105", stake: "37800.48125104"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "31556.02338731", stake: "31566.02338729"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "6244.45786374", stake: "6254.45786374"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(post, null);
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(post2, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"151198.07499582","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"55.5992921371","active":true,"intervalPendingClaims":"55.5992921371","intervalRewardPool":"302400.00000000"}');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "author1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"5.0118723362","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"author1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"0.0000000000","curationWeight":"0.0000000000","timestamp":1527811200000,"voter":"author1"}]');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter2", "author": "author1", "permlink": "test2", "weight": 8000 }'));

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
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527811200000,"votingPower":9840,"downvotingPower":10000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"30.1210400252","active":true}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"4.9414937793","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"2.5625265445","timestamp":1527811200000,"voter":"voter2"}]');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"30.1203427857","active":true,"intervalPendingClaims":"30.1203427857","intervalRewardPool":"15.00000000"}');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"26894.12143368"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"48706.84106812"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"26894.12143368"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'author1')), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"32074.08052775"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"16632.76054036"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "37800.48125090", stake: "37800.48125090"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "29484.10098072", stake: "29494.10098071"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "8316.38027018", stake: "8326.38027018"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(post, null);
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(post2, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"151198.07499640","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"60.2413130878","active":true,"intervalPendingClaims":"60.2413130878","intervalRewardPool":"302400.00000000"}');

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

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0.0000000000","active":true,"intervalPendingClaims":"0.0000000000","intervalRewardPool":"15.00000000"}');

      // forward clock past payout time
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // this transaction pays out with maintenance op
      transactions.push(maintenanceOp(refBlockNumber));
      // this vote should be ignored.
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));

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
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');
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
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"0.9800000000"}');
      votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"0.9800000000","curationWeight":"0","timestamp":1527811200000,"voter":"voter1"}]');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7149450175","active":true,"intervalPendingClaims":"10.7149450175","intervalRewardPool":"15.00000000"}');

      // pay out post
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"12663.08250736"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1'), undefined);

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "6331.54125368", stake: "6331.54125368"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(post, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"277073.83498528","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"11.6943264346","active":true,"intervalPendingClaims":"11.6943264346","intervalRewardPool":"302400.00000000"}');

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0378178077","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.0000000000","voteRshareSum":"1.0000000000"}');
      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"1.0000000000","curationWeight":"1.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.9960000000","voteRshareSum":"1.9960000000"}');
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
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.0000000000","voteRshareSum":"0.0000000000"}');
      votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":1000,"rshares":"1.0000000000","curationWeight":"1.0000000000","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":-1000,"rshares":"-1.0000000000","curationWeight":"0","timestamp":1527811200000,"voter":"voter2"}]');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0378178077","active":true}');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-01T23:59:57', "43198.5");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43198.5","lastRewardTimestamp":1527897597000,"lastClaimDecayTimestamp":1527897597000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0377474881","active":true,"intervalPendingClaims":"3.0377474881","intervalRewardPool":"15.00000000"}');

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
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newVote')), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"-10.0000000000"}}');
      vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527897600000,"votingPower":10000,"downvotingPower":8000}');
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"43200.00000000","lastRewardTimestamp":1527897600000,"lastClaimDecayTimestamp":1527897600000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0377404562","active":true,"intervalPendingClaims":"3.0377404562","intervalRewardPool":"43200.00000000"}');

      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"1.9960000000","voteRshareSum":"-8.0040000000"}');
      votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":2000,"rshares":"1.9960000000","curationWeight":"1.6222298031","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":-10000,"rshares":"-10.0000000000","curationWeight":"0","timestamp":1527897600000,"voter":"voter2"}]');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0376701384","active":true,"intervalPendingClaims":"3.0376701384","intervalRewardPool":"43215.00000000"}');

      // forward clock and then pay out both posts
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
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
      assert.equal(post, null);
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(post2, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302400.00000000","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"3.0376631067","active":true,"intervalPendingClaims":"3.0376631067","intervalRewardPool":"302400.00000000"}');

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
      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.5", voteRegenerationDays: 5, downvoteRegenerationDays: 10, cashoutWindowDays: 14});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test2", "rewardPools": [1] }'));
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

      let vp;
      let vote;
      let downvote;

      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      vp.votingPower = 10;
      vp.downvotingPower = 100;
      await fixture.database.update({ contract: 'comments', table: 'votingPower', record: vp });

      const votingPowerTable = [];
      const votingRsharesTable = [];
      const downvotingPowerTable = [];
      const downvotingRsharesTable = [];
      for (let i = 0; i < 300; i += 1) {
        transactions = [];
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test2", "weight": -10000 }'));
          block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await fixture.sendBlock(block);
        await tableAsserts.assertNoErrorInLastBlock();
        vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
        votingPowerTable.push(vp.votingPower);
        downvotingPowerTable.push(vp.downvotingPower);

        vote = await fixture.database.findOne({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: '@author1/test1', voter: 'voter1' }});
        downvote = await fixture.database.findOne({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: '@author1/test2', voter: 'voter1' }});

        const voteRshares = vote.rshares;
        const downvoteRshares = downvote.rshares;
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

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 1 }'));
        block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-06T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});

      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1528243200000,"votingPower":9999,"downvotingPower":5000}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 1 }'));
        block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-11T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});

      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1528675200000,"votingPower":9999,"downvotingPower":10000}');

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "ABC", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "ABC", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "ABC", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2", "curationRewardCurve": "power", "curationRewardCurveParameter": "1", "curationRewardPercentage": 75, "cashoutWindowDays": 7, "rewardPerInterval": "0.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 300, "downvotePowerConsumption": 1000, "tags":["scottest"] }, "isSignedWithActiveKey": true }'));
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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerInterval":"0.5","rewardIntervalSeconds":3,"voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000,"tags":["scottest"]},"pendingClaims":"2500.0000000000","active":true}');
      let rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"50.0000000000","voteRshareSum":"50.0000000000"}');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

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

  it('create comment and reply with two reward pools using tags', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "ABC", "precision": 8, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "ABC", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "ABC", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2", "curationRewardCurve": "power", "curationRewardCurveParameter": "1", "curationRewardPercentage": 75, "cashoutWindowDays": 7, "rewardPerInterval": "0.5", "rewardIntervalSeconds": 3, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 300, "downvotePowerConsumption": 1000, "tags":["scottest"] }, "isSignedWithActiveKey": true }'));
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

      await setUpRewardPool({ postRewardCurveParameter: '1.03', curationRewardCurveParameter: '0.5', tags: ['test', 'tag2']});

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "jsonMetadata": {"tags": ["a", "b", "scottest", "c", "tag2", "d"]} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'vote', '{ "voter": "voter1", "author": "author1", "permlink": "test1", "weight": 10000 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author2", "permlink": "re-test1", "parentAuthor": "author1", "parentPermlink": "test1"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author2", "permlink": "nopools", "parentAuthor": "other", "parentPermlink": "nonindexed"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author3", "permlink": "test3", "parentPermlink": "scottest", "jsonMetadata": {"tags": []} }'));

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

      let vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9700,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 2}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":2,"account":"voter1"},"rewardPoolId":2,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9800,"downvotingPower":10000}');
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerInterval":"0.5","rewardIntervalSeconds":3,"voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000,"tags":["scottest"]},"pendingClaims":"2500.0000000000","active":true}');
      let rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["test","tag2"]},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"50.0000000000","voteRshareSum":"50.0000000000"}');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

      let post3 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author3/test3" }});
      assert.equal(JSON.stringify(post3), '{"_id":{"authorperm":"@author3/test3","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author3/test3","author":"author3","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"0","voteRshareSum":"0"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","weight":10000,"rshares":"50.0000000000","curationWeight":"50.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":2,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');
      
      let reply = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author2/re-test1" }});
      assert.equal(JSON.stringify(reply), '{"_id":{"authorperm":"@author2/re-test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author2/re-test1","author":"author2","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"0","voteRshareSum":"0"}');
      let reply2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author2/re-test1" }});
      assert.equal(JSON.stringify(reply2), '{"_id":{"authorperm":"@author2/re-test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author2/re-test1","author":"author2","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"0","voteRshareSum":"0"}');

      reply = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author2/nopools" }});
      assert.equal(reply, null);
      reply2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author2/nopools" }});
      assert.equal(reply2, null);

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"67.8415540697","active":true}');
      
      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"60.0000000000","voteRshareSum":"60.0000000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"60.0000000000","curationWeight":"7.7459666924","timestamp":1527811200000,"voter":"voter1"}]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays out maxPostsProcessedPerRound and respects voteQueryLimit', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1.03", curationRewardCurveParameter: "0.7"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateParams', '{ "maxPostsProcessedPerRound": 1, "maxVotesProcessedPerRound": 2, "voteQueryLimit": 2 }'));

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
      assert.equal(params.maxVotesProcessedPerRound, 2);
      assert.equal(params.voteQueryLimit, 2);

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

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
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      res = await fixture.database.getLatestBlockInfo();
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'newComment')), '{"contract":"comments","event":"newComment","data":{"rewardPoolId":1,"symbol":"TKN"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[1].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"9.8000000000"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[2].logs).events[0]), '{"contract":"comments","event":"newVote","data":{"rewardPoolId":1,"symbol":"TKN","rshares":"8.0000000000"}}');
      vp = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter1', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp), '{"_id":{"rewardPoolId":1,"account":"voter1"},"rewardPoolId":1,"account":"voter1","lastVoteTimestamp":1527811200000,"votingPower":9604,"downvotingPower":10000}');
      let vp2 = await fixture.database.findOne({ contract: 'comments', table: 'votingPower', query: { account: 'voter2', rewardPoolId: 1}});
      assert.equal(JSON.stringify(vp2), '{"_id":{"rewardPoolId":1,"account":"voter2"},"rewardPoolId":1,"account":"voter2","lastVoteTimestamp":1527811200000,"votingPower":9840,"downvotingPower":10000}');

      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000"}');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // weights are 9.8^0.7 vs 17.8^0.7 - 9.8^0.7
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter1"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":10000,"rshares":"9.8000000000","curationWeight":"4.9414937793","timestamp":1527811200000,"voter":"voter1"},{"_id":{"rewardPoolId":1,"authorperm":"@author1/test2","voter":"voter2"},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","weight":8000,"rshares":"8.0000000000","curationWeight":"2.5625265445","timestamp":1527811200000,"voter":"voter2"}]');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"30.1210400252","active":true}');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"30.1203427857","active":true,"intervalPendingClaims":"30.1203427857","intervalRewardPool":"15.00000000"}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

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
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      // reward pool should be 302400, calc will be ~ 10^1.03  / (30.1203427857*(1 - 3/(15*24*3600)) + 10^1.03 + 17.8^1.03) * 302400 * 0.5
      // ~26894.12143379302 (rounding affects result)
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"26894.12143368"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"voter1","quantity":"26894.12143368"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2'), undefined);

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "13447.06071684", stake: "13447.06071684"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "13447.06071684", stake: "13457.06071684"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(post, null);
      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      // not paid out yet
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"248611.75713264","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"60.2413130878","active":true,"intervalPendingClaims":"60.2413130878","intervalRewardPool":"302400.00000000"}');

      // forward clock and then pay out second post (3 seconds min gap time)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      // reward pool waits for last interval to finish processing
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract'), undefined);
      // ratio between author rewards should satisfy rshares1^a / rshares2^a ~ payout1 / payout2
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1'), undefined);
      // Votes have finished processing, but post has not paid out yet (vote limit matched exactly votes remaining)
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter1","quantity":"32074.08052775"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2')), '{"contract":"comments","event":"curationReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"voter2","quantity":"16632.76054036"}}');

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "13447.06071684", stake: "13447.06071684"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "29484.10098072", stake: "29494.10098071"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "8316.38027018", stake: "8326.38027018"});

      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test2","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test2","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"17.8000000000","voteRshareSum":"17.8000000000"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"248611.75713264","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"60.2413130878","active":true,"intervalPendingClaims":"60.2413130878","intervalRewardPool":"302400.00000000"}');

      // forward clock and then finish paying out second post (3 seconds min gap time)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:06',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      // reward pool waits for last interval to finish processing
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test2')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test2","symbol":"TKN","account":"author1","quantity":"48706.84106812"}}');
      // curation reward in last block
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test2' && ev.data.account === 'voter2'), undefined);

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: "37800.48125090", stake: "37800.48125090"});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "29484.10098072", stake: "29494.10098071"});
      await tableAsserts.assertUserBalances({account: "voter2", symbol: "TKN", balance: "8316.38027018", stake: "8326.38027018"});

      post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test2" }});
      assert.equal(post2, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"151198.07499640","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"60.2413130878","active":true,"intervalPendingClaims":"60.2413130878","intervalRewardPool":"302400.00000000"}');

      // forward clock and then finalize reward interval (3 seconds min gap time)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:09',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});

      // check that lastClaimDecayTimestamp has advanced
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"151198.07499640","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.7","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"60.2413130878","active":true,"intervalPendingClaims":"60.2413130878","intervalRewardPool":"302400.00000000"}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('processes maintenanceTokensPerBlock per block', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(miningContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "ABC", "precision": 4, "maxSupply": "1000000000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "ABC", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'comments', 'createRewardPool', '{ "symbol": "ABC", "config": { "postRewardCurve": "power", "postRewardCurveParameter": "2", "curationRewardCurve": "power", "curationRewardCurveParameter": "1", "curationRewardPercentage": 75, "cashoutWindowDays": 7, "rewardPerInterval": "0.5", "rewardIntervalSeconds": 6, "voteRegenerationDays": 5, "downvoteRegenerationDays": 5, "stakedRewardPercentage": 50, "votePowerConsumption": 300, "downvotePowerConsumption": 1000, "tags":["scottest"] }, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "ABC", "quantity": "1000", "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'stake', '{ "symbol": "ABC", "quantity": "50", "to": "voter1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'comments', 'updateParams', '{ "maintenanceTokensPerBlock": 1 }'));

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
      assert.equal(params.maintenanceTokensPerBlock, 1);

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
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerInterval":"0.5","rewardIntervalSeconds":6,"voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000,"tags":["scottest"]},"pendingClaims":"2500.0000000000","active":true}');
      let rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7151930523","active":true}');

      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"50.0000000000","voteRshareSum":"50.0000000000"}');
      let post2 = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post2), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":2},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000"}');

      let votes = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes), '[{"_id":{"rewardPoolId":1,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":1,"symbol":"ABC","authorperm":"@author1/test1","weight":10000,"rshares":"50.0000000000","curationWeight":"50.0000000000","timestamp":1527811200000,"voter":"voter1"}]');
      let votes2 = await fixture.database.find({ contract: 'comments', table: 'votes', query: { rewardPoolId: 2, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(votes2), '[{"_id":{"rewardPoolId":2,"authorperm":"@author1/test1","voter":"voter1"},"rewardPoolId":2,"symbol":"TKN","authorperm":"@author1/test1","weight":10000,"rshares":"10.0000000000","curationWeight":"3.1622776601","timestamp":1527811200000,"voter":"voter1"}]');

      // forward 11 blocks and verify maintenance
      // because it just did one round above, it will start with TKN (id=2)
      const tokensIssued = {
          'TKN': BigNumber(0),
          'ABC': BigNumber(0),
      };
      for (let i = 0; i < 11; i += 1) {
        transactions = [];
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions.push(maintenanceOp(refBlockNumber));
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: new Date(new Date('2018-06-01T00:00:00.000Z').getTime() + ((i + 1) * 3000)).toISOString().replace('.000Z',''),
          transactions,
        };

        await fixture.sendBlock(block);
        res = await fixture.database.getLatestBlockInfo();
        await tableAsserts.assertNoErrorInLastBlock();
        if (res.transactions) {
          res.transactions.forEach(t => {
            const logs = JSON.parse(t.logs);
            if (logs) {
              const events = logs.events;
              if (events) {
                const issueContractEvent = events.find(ev => ev.event === 'issueToContract');
                if (issueContractEvent) {
                  tokensIssued[issueContractEvent.data.symbol] = tokensIssued[issueContractEvent.data.symbol].plus(issueContractEvent.data.quantity);
                }
              }
            }
          });
        }
      }
      assert.equal(tokensIssued['ABC'].toFixed(), '2.5');  // 5*0.5
      assert.equal(tokensIssued['TKN'].toFixed(), '9');  // 6*1.5

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"2.5000","lastRewardTimestamp":1527811230000,"lastClaimDecayTimestamp":1527811230000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerInterval":"0.5","rewardIntervalSeconds":6,"voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000,"tags":["scottest"]},"pendingClaims":"2499.9421301652","active":true,"intervalPendingClaims":"2499.9421301652","intervalRewardPool":"2.5000"}');
      rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"9.00000000","lastRewardTimestamp":1527811218000,"lastClaimDecayTimestamp":1527811218000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"10.7150442307","active":true,"intervalPendingClaims":"10.7150442307","intervalRewardPool":"9.00000000"}');

      // forward clock and mock state. Since it processes 1 token per block,
      // it will not have caught up with maintenance, but let's pretend it has
      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      rewardPool.lastClaimDecayTimestamp = new Date('2018-06-07T23:59:54.000Z').getTime();
      rewardPool.lastRewardTimestamp = new Date('2018-06-07T23:59:54.000Z').getTime();
      rewardPool.rewardPool = '50399.50000000';
      await fixture.database.update({ contract: 'comments', table: 'rewardPools', record: rewardPool });

      let tokensContractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { account: 'comments', symbol: 'ABC'}});
      tokensContractBalance.balance = '50399.50000000';
      await fixture.database.update({ contract: 'tokens', table: 'contractsBalances', record: tokensContractBalance });

      rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      rewardPool2.lastClaimDecayTimestamp = new Date('2018-06-07T23:59:57.000Z').getTime();
      rewardPool2.lastRewardTimestamp = new Date('2018-06-07T23:59:57.000Z').getTime();
      rewardPool2.rewardPool = '302398.50000000';
      await fixture.database.update({ contract: 'comments', table: 'rewardPools', record: rewardPool2 });

      tokensContractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { account: 'comments', symbol: 'TKN'}});
      tokensContractBalance.balance = '302398.50000000';
      await fixture.database.update({ contract: 'tokens', table: 'contractsBalances', record: tokensContractBalance });

      // forward clock and process one token (two comment actions, but should only process once)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'ABC')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"ABC","quantity":"0.5"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1' && ev.data.symbol === 'ABC')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"ABC","account":"author1","quantity":"6300.0875"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'TKN'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1' && ev.data.symbol === 'TKN'), undefined);
      assert.equal(JSON.parse(res.transactions[1].logs).events, undefined);

      // forward clock and process one token (two comment actions, but should only process once)
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(maintenanceOp(refBlockNumber));
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-08T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'ABC'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1' && ev.data.symbol === 'ABC'), undefined);
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'TKN')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"1.5"}}');
      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1' && ev.data.symbol === 'TKN')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":2,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"75600.61250209"}}');
      assert.equal(JSON.parse(res.transactions[1].logs).events, undefined);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"ABC","rewardPool":"25199.6500","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"2","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":75,"cashoutWindowDays":7,"rewardPerInterval":"0.5","rewardIntervalSeconds":6,"voteRegenerationDays":5,"downvoteRegenerationDays":5,"stakedRewardPercentage":50,"votePowerConsumption":300,"downvotePowerConsumption":1000,"tags":["scottest"]},"pendingClaims":"4999.9305563590","active":true,"intervalPendingClaims":"4999.9305563590","intervalRewardPool":"50400.0000"}');
      rewardPool2 = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 2}});
      assert.equal(JSON.stringify(rewardPool2), '{"_id":2,"symbol":"TKN","rewardPool":"151198.77499582","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1.03","curationRewardCurve":"power","curationRewardCurveParameter":"0.5","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"21.4302124796","active":true,"intervalPendingClaims":"21.4302124796","intervalRewardPool":"302400.00000000"}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays beneficiary', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await runBeneficiaryTest({});
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('pays beneficiary with all muted users', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await runBeneficiaryTest({ muteAll: true });
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('does not pay for post declined payout', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "1"});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'comment', '{ "author": "author1", "permlink": "test1", "rewardPools": [1] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'null', 'comments', 'commentOptions', '{ "author": "author1", "permlink": "test1", "maxAcceptedPayout": "0.000 HBD", "beneficiaries": [{"account": "bene1", "weight": 5000}, {"account": "bene2", "weight": 1}]}'));
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
      let post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(JSON.stringify(post), '{"_id":{"authorperm":"@author1/test1","rewardPoolId":1},"rewardPoolId":1,"symbol":"TKN","authorperm":"@author1/test1","author":"author1","created":1527811200000,"cashoutTime":1528416000000,"votePositiveRshareSum":"10.0000000000","voteRshareSum":"10.0000000000","beneficiaries":[{"account":"bene1","weight":5000},{"account":"bene2","weight":1}],"declinePayout":true}');

      // catch up post maintenance
      await forwardPostMaintenanceAndAssertIssue('2018-06-07T23:59:57', "302398.50000000");
      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302398.50000000","lastRewardTimestamp":1528415997000,"lastClaimDecayTimestamp":1528415997000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"9.9997685205","active":true,"intervalPendingClaims":"9.9997685205","intervalRewardPool":"15.00000000"}');

      // forward clock past payout time
      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // this transaction pays out with maintenance op
      transactions.push(maintenanceOp(refBlockNumber));

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

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'authorReward' && ev.data.authorperm === '@author1/test1')), '{"contract":"comments","event":"authorReward","data":{"rewardPoolId":1,"authorperm":"@author1/test1","symbol":"TKN","account":"author1","quantity":"0"}}');
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'beneficiaryReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'bene1'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'beneficiaryReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'bene2'), undefined);
      assert.equal(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'curationReward' && ev.data.authorperm === '@author1/test1' && ev.data.account === 'voter1'), undefined);

      await tableAsserts.assertUserBalances({account: "author1", symbol: "TKN", balance: 0, stake: 0});
      await tableAsserts.assertUserBalances({account: "bene1", symbol: "TKN", balance: 0, stake: 0});
      await tableAsserts.assertUserBalances({account: "bene2", symbol: "TKN", balance: 0, stake: 0});
      await tableAsserts.assertUserBalances({account: "voter1", symbol: "TKN", balance: "0", stake: "10.00000000"});

      post = await fixture.database.findOne({ contract: 'comments', table: 'posts', query: { rewardPoolId: 1, authorperm: "@author1/test1" }});
      assert.equal(post, null);

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"302400.00000000","lastRewardTimestamp":1528416000000,"lastClaimDecayTimestamp":1528416000000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"1.5","rewardIntervalSeconds":3,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"19.9997453728","active":true,"intervalPendingClaims":"19.9997453728","intervalRewardPool":"302400.00000000"}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('inserts correct amount to reward pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      await setUpRewardPool({ postRewardCurveParameter: "1", curationRewardCurveParameter: "1", "rewardPerInterval": "0.01", "rewardIntervalSeconds": 6});

      let transactions;
      let refBlockNumber;
      let block;

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // this transaction will trigger maintenance op
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:03',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();
      let res = await fixture.database.getLatestBlockInfo();

      let contractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { "account": "comments", "symbol": "TKN" }});
      assert.equal(null, contractBalance);

      let rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0","lastRewardTimestamp":1527811200000,"lastClaimDecayTimestamp":1527811200000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"0.01","rewardIntervalSeconds":6,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0","active":true}');

      transactions = [];
      refBlockNumber = fixture.getNextRefBlockNumber();
      // this transaction will trigger maintenance op
      transactions.push(maintenanceOp(refBlockNumber));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:06',
        transactions,
      };

      await fixture.sendBlock(block);
      res = await fixture.database.getLatestBlockInfo();
      await tableAsserts.assertNoErrorInLastBlock();

      assert.equal(JSON.stringify(JSON.parse(res.transactions[0].logs).events.find(ev => ev.event === 'issueToContract' && ev.data.symbol === 'TKN')), '{"contract":"tokens","event":"issueToContract","data":{"from":"tokens","to":"comments","symbol":"TKN","quantity":"0.01"}}');

      contractBalance = await fixture.database.findOne({ contract: 'tokens', table: 'contractsBalances', query: { "account": "comments", "symbol": "TKN" }});
      assert.equal(JSON.stringify(contractBalance), '{"_id":1,"account":"comments","symbol":"TKN","balance":"0.01","stake":"0","pendingUnstake":"0","delegationsIn":"0","delegationsOut":"0","pendingUndelegations":"0"}');

      rewardPool = await fixture.database.findOne({ contract: 'comments', table: 'rewardPools', query: { _id: 1}});
      assert.equal(JSON.stringify(rewardPool), '{"_id":1,"symbol":"TKN","rewardPool":"0.01000000","lastRewardTimestamp":1527811206000,"lastClaimDecayTimestamp":1527811206000,"createdTimestamp":1527811200000,"config":{"postRewardCurve":"power","postRewardCurveParameter":"1","curationRewardCurve":"power","curationRewardCurveParameter":"1","curationRewardPercentage":50,"cashoutWindowDays":7,"rewardPerInterval":"0.01","rewardIntervalSeconds":6,"voteRegenerationDays":14,"downvoteRegenerationDays":14,"stakedRewardPercentage":50,"votePowerConsumption":200,"downvotePowerConsumption":2000,"tags":["scottest"]},"pendingClaims":"0.0000000000","active":true,"intervalPendingClaims":"0.0000000000","intervalRewardPool":"0.01000000"}');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
