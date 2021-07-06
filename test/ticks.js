/* eslint-disable */
const assert = require('assert').strict;
const { MongoClient } = require('mongodb');
const dhive = require('@hiveio/dhive');
const enchex = require('crypto-js/enc-hex');

const { CONSTANTS } = require('../libs/Constants');
const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');
const { Fixture, conf } = require('../libs/util/testing/Fixture');
const { TableAsserts } = require('../libs/util/testing/TableAsserts');
const { assertError } = require('../libs/util/testing/Asserts');


const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

const initialTickContracts = new Set(CONSTANTS.INITIAL_CONTRACT_TICKS.map(t => t.contract));

async function getTickingActionsAtRefblock(refBlockNumber) {
  const transactions = [];
  transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'dummy', 'dummy', 'dummy', '{}'));
  const block = {
    refHiveBlockNumber: refBlockNumber,
    refHiveBlockId: 'ABCD1',
    prevRefHiveBlockId: 'ABCD2',
    timestamp: '2018-06-01T00:00:00',
    transactions,
  };

  await fixture.sendBlock(block);

  const res = await fixture.database.getLatestBlockInfo();
  return res.virtualTransactions.map(v => `${v.contract}.${v.action}`); 
}

describe('ticks', function () {
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
  
  it('should trigger ticks at expected refblock', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      let refBlockNumber = 1000;
      initialTickContracts.forEach(c =>
          transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update',
              JSON.stringify(setupContractPayload(c, './contracts/testing/dummyTicks.js')))));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      const expectedTickedActions = [
        'tokens.checkPendingUnstakes',
        'tokens.checkPendingUndelegations',
        'nft.checkPendingUndelegations'
      ];
      let tickedActions = await getTickingActionsAtRefblock(1001);
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));

      tickedActions = await getTickingActionsAtRefblock(45251626);
      expectedTickedActions.push('botcontroller.tick');
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));

      tickedActions = await getTickingActionsAtRefblock(47746850);
      expectedTickedActions.push('mining.checkPendingLotteries');
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));
      
      tickedActions = await getTickingActionsAtRefblock(48664773);
      expectedTickedActions.push('airdrops.checkPendingAirdrops');
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));

      tickedActions = await getTickingActionsAtRefblock(51022551);
      expectedTickedActions.push('witnesses.scheduleWitnesses');
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));

      tickedActions = await getTickingActionsAtRefblock(53610300);
      expectedTickedActions.push('tokenfunds.checkPendingDtfs');
      assert.equal(JSON.stringify(tickedActions), JSON.stringify(expectedTickedActions));

      tickedActions = await getTickingActionsAtRefblock(54560500);
      expectedTickedActions.push('nftauction.updateAuctions');
      // manually checked since updateAuctions code was added before the others but at a later block
      assert.equal(JSON.stringify(tickedActions), '["tokens.checkPendingUnstakes","tokens.checkPendingUndelegations","nft.checkPendingUndelegations","botcontroller.tick","mining.checkPendingLotteries","airdrops.checkPendingAirdrops","nftauction.updateAuctions","witnesses.scheduleWitnesses","tokenfunds.checkPendingDtfs"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should register tick', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update',
              JSON.stringify(setupContractPayload('testtick', './contracts/testing/dummyTicks.js'))));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick',
              '{ "contractName": "testtick", "tickAction": "tick"}'));

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
      const tickedActions = await getTickingActionsAtRefblock(refBlockNumber);
      assert.equal(JSON.stringify(tickedActions), '["testtick.tick"]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not register tick', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let transactions = [];
      let refBlockNumber = fixture.getNextRefBlockNumber();
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick',
              '{ "contractName": "notexist", "tickAction": "tick"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'unauthorized', 'contract', 'registerTick',
              '{ "contractName": "tokens", "tickAction": "issue"}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'registerTick',
              '{ "contractName": "tokens", "tickAction": "checkPendingUnstakes"}'));

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
      assertError(txs[0], 'contract does not exist');
      assertError(txs[1], 'registerTick unauthorized');
      assertError(txs[2], 'contract tick already registered');

      refBlockNumber = fixture.getNextRefBlockNumber();
      const tickedActions = await getTickingActionsAtRefblock(refBlockNumber);
      assert.equal(JSON.stringify(tickedActions), '[]');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });
});
