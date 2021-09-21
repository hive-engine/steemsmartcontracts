/* eslint-disable */
const assert = require('assert');
const { MongoClient } = require('mongodb');

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
const nftContractPayload = setupContractPayload('nft', './contracts/nft.js');
const contractPayload = setupContractPayload('mining', './contracts/mining.js');

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

async function assertNftInstance(account, symbol, id, delegatedTo, properties) {
  let res = await fixture.database.findOne({
      contract: 'nft',
      table: `${symbol}instances`,
      query: {
        account,
        _id: id,
      }
    });

  assert.ok(res, `No NFT found for ${account}, ${symbol} with ID ${id}`);

  if (delegatedTo) {
    assert.equal(JSON.stringify(res.delegatedTo), JSON.stringify(delegatedTo), `${account} NFT ${symbol} with ID ${id} has delegatedTo ${JSON.stringify(res.delegatedTo)}, expected ${JSON.stringify(delegatedTo)}`);
  } else if (delegatedTo === undefined) {
    assert(res.delegatedTo === undefined, `${account} NFT ${symbol} with ID ${id} has delegatedTo ${JSON.stringify(res.delegatedTo)}, expected undefined`);
  }

  if (properties) {
    const keys = Object.keys(properties);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      assert.equal(res.properties[k], properties[k], `${account} NFT ${symbol} with ID ${id} has property ${k} = ${res.properties[k]}, expected ${properties[k]}`);
    }
  }
}

async function assertMiningPower(account, id, power, nftBalances, equippedNfts) {
  let res = await fixture.database.findOne({
      contract: 'mining',
      table: 'miningPower',
      query: {
        id,
        account,
      }
    });
  if (!power) {
    assert(!res, `Power found for ${account} in pool ${id}, expected to be missing.`);
    return;
  }
  assert.ok(res, `No power for ${account} in pool ${id}`);

  if (nftBalances) {
      assert.equal(JSON.stringify(res.nftBalances), JSON.stringify(nftBalances), `${account} has ${id} equipped nfts ${JSON.stringify(res.nftBalances)}, expected ${JSON.stringify(nftBalances)}`);
  }

  if (equippedNfts) {
      assert.equal(JSON.stringify(res.equippedNfts), JSON.stringify(equippedNfts), `${account} has ${id} nft balances ${JSON.stringify(res.equippedNfts)}, expected ${JSON.stringify(equippedNfts)}`);
  }

  assert.equal(res.power['$numberDecimal'], power, `${account} has ${id} power ${res.power['$numberDecimal']}, expected ${power}`);
}

async function assertPool(pool, updating) {
  const { id } = pool;
  let res = await fixture.database.findOne({
      contract: 'mining',
      table: 'pools',
      query: {
        id,
      }
    });

  assert.ok(res, `Pool ${id} not found.`);

  let error = false;
  Object.keys(pool).forEach(k => {
    if (res[k] !== pool[k]) {
        error = true;
        console.log(`Pool ${id} has ${k} ${res[k]}, expected ${pool[k]}`);
    }
  });
  if (updating) {
    Object.keys(updating).forEach(k => {
      if (res.updating[k] !== updating[k]) {
          error = true;
          console.log(`Pool ${id} has updating.${k} ${res.updating[k]}, expected ${updating[k]}`);
      }
    });
  }
  assert(!error, 'Mismatch fields in pool');
}

async function assertTokenPool(symbol, poolId) {
  let res = await fixture.database.findOne({
      contract: 'mining',
      table: 'tokenPools',
      query: {
        symbol,
        id: poolId,
      }
    });

  assert.ok(res, `Token pool ${poolId} not found for ${symbol}.`);
}

async function assertNftTokenPool(symbol, poolId) {
  let res = await fixture.database.findOne({
      contract: 'mining',
      table: 'nftTokenPools',
      query: {
        symbol,
        id: poolId,
      }
    });

  assert.ok(res, `NFT Token pool ${poolId} not found for ${symbol}.`);
}

async function assertTotalStaked(amount, symbol='TKN') {
    let res = await fixture.database.findOne({
        contract: 'tokens',
        table: 'tokens',
        query: {
            symbol,
        },
    });

    assert.equal(res.totalStaked, amount, `${symbol} has ${res.totalStaked} staked, expected ${amount}`);
}

async function assertParams(key, value) {
    let res = await fixture.database.findOne({
        contract: 'tokens',
        table: 'params',
        query: {},
    });
    assert.equal(res[key], value, `Params for ${key} is ${res[key]}, expected ${value}`);
}

async function finishPowerUpdate(poolId) {
  const poolQuery = {
      contract: 'mining',
      table: 'pools',
      query: {
          id: poolId,
      }
  };
  let res = await fixture.database.findOne(poolQuery);
  let refBlockNumber;
  while (res.updating.inProgress) {
    refBlockNumber = fixture.getNextRefBlockNumber();
    const block = {
      refHiveBlockNumber: refBlockNumber,
      refHiveBlockId: 'ABCD1',
      prevRefHiveBlockId: 'ABCD2',
      timestamp: '2018-06-01T00:00:00',
      transactions: [new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', '')],
    };
    await fixture.sendBlock(block);
    res = await fixture.database.findOne(poolQuery);
  }
}

describe('mining', function () {
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

  it('should not create mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": 2, "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "12345678901", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": "1", "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 0, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 21, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": "0", "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 0, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 721, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "NOTKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "satoshi", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": "tokenMiners", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "TKN2", "multiplier": 2}, {"symbol": "TKN3", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "NOTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": "garbage"}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 0}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 101}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "-1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "MTKN", "multiplier": 1}, {"symbol": "TKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "TKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'you must have enough tokens to cover the creation fee');
      // 1 sets creation fee to 0
      assertError(txs[2], 'you must use a custom_json signed with your active key');
      assertError(txs[3], 'invalid params');
      assertError(txs[4], 'invalid params');
      assertError(txs[5], 'invalid symbol: uppercase letters only, max length of 10');
      assertError(txs[6], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[7], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[8], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[9], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[10], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[11], 'invalid lotteryIntervalHours: integer between 1 and 720 only');
      assertError(txs[12], 'minedToken does not exist');
      // 13 creates token
      assertError(txs[14], 'must be issuer of minedToken');
      assertError(txs[15], 'minedToken precision mismatch for lotteryAmount');
      assertError(txs[16], 'tokenMiners invalid');
      assertError(txs[17], 'only 1 or 2 tokenMiners allowed');
      // 18-19 creates new token
      assertError(txs[20], 'tokenMiners must have staking enabled');
      assertError(txs[21], 'tokenMiners must have staking enabled');
      // 22 enables staking
      assertError(txs[23], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[24], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[25], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[26], 'invalid params');
      // 27 is successful
      assertError(txs[28], 'pool already exists');
      assertError(txs[29], 'pool already exists');
      assertError(txs[30], 'tokenMiners cannot have duplicate symbols');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should create mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.MTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}, {"symbol": "TEST.MTKN", "multiplier": 2}], "isSignedWithActiveKey": true }'));

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

      await tableAsserts.assertNoErrorInLastBlock();

      await assertPool({id: 'TEST-TKN:TEST-MTKN,TEST-TKN', totalPower: '0'});

      let eventLog = JSON.parse(res.transactions[8].logs);
      let createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN:TEST-MTKN,TEST-TKN');
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should update mining power on stake and delegation updates', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  console.log((await fixture.database.getLatestBlockInfo()).virtualTransactions);

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.00000000', stake: '30.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '75.00000000', stake: '5.00000000'});
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '20.00000000'});

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'});

      // allow mining power update to resume
      await finishPowerUpdate('TKN:MTKN,TKN');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '100');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '150'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to": "satoshi2", "symbol": "MTKN", "quantity": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '40.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '30.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '60');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '140');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'delegate', '{ "to": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'tokens', 'delegate', '{ "to": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '35.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '5.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '5.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '25.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '75');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '125');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'undelegate', '{ "from": "satoshi2", "symbol": "TKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'tokens', 'undelegate', '{ "from": "satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '35.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '25.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '55');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '120');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '175' });

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

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '40.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '30.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '60');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '140');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '200' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      const unstakeId = fixture.getNextTxId();
      const unstakeId2 = fixture.getNextTxId();
      transactions.push(new Transaction(refBlockNumber, unstakeId, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, unstakeId2, 'satoshi2', 'tokens', 'unstake', '{ "symbol": "MTKN", "quantity": "0.00000005", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '39.99999998' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '29.99999998' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999998');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.99999992');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.9999999' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000002', stake: '39.99999995' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0.00000002', stake: '29.99999995' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999995');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.9999998');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.99999975' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId}", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'tokens', 'cancelUnstake', `{ "txID": "${unstakeId2}", "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000002', stake: '39.99999998' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '65.00000000', stake: '5.00000000', delegationsIn: '0.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0.00000002', stake: '29.99999998' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '59.99999998');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '139.99999992');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '199.9999999' });

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "300", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": 2, "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "blah", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "-15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2.7, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 0, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 21, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN9", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "0.000000001", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "NOTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 101}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 0}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": "a"}], "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'you must have enough tokens to cover the update fee');
      assertError(txs[2], 'you must use a custom_json signed with your active key');
      assertError(txs[3], 'invalid params');
      assertError(txs[4], 'invalid params');
      assertError(txs[5], 'invalid params');
      assertError(txs[6], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[7], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[8], 'invalid lotteryWinners: integer between 1 and 20 only');
      assertError(txs[9], 'pool id not found');
      assertError(txs[11], 'must be issuer of minedToken');
      assertError(txs[12], 'minedToken precision mismatch for lotteryAmount');
      assertError(txs[13], 'cannot change which tokens are in tokenMiners');
      assertError(txs[14], 'cannot change which tokens are in tokenMiners');
      assertError(txs[15], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[16], 'tokenMiner multiplier must be an integer from 1 to 100');
      assertError(txs[17], 'tokenMiner multiplier must be an integer from 1 to 100');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not set mining pool active', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "3200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN9", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'you must use a custom_json signed with your active key');
      assertError(txs[1], 'pool id not found');
      assertError(txs[2], 'must be issuer of minedToken');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7300", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 2, "numberTransactions": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "11", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.00000000', stake: '30.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '84.00000000', stake: '5.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '11.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1 });

      // allow mining power update to resume
      await finishPowerUpdate('TKN:MTKN,TKN');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '64');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '114', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TKN:MTKN,TKN", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 2}, {"symbol": "MTKN", "multiplier": 3}], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await finishPowerUpdate('TKN:MTKN,TKN');

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.00000000', stake: '30.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '84.00000000', stake: '5.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '11.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '75');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '73');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '148', lotteryWinners: 2, lotteryIntervalHours: 3, lotteryAmount: "15.7", nextLotteryTimestamp: new Date('2018-06-02T03:00:00.000Z').getTime() });

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update mining pool for utility token as api owner', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', `{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "tokenMiners": [{"symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "multiplier": 1}], "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool(CONSTANTS.UTILITY_TOKEN_SYMBOL, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      await assertPool({id: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`, totalPower: '0', lotteryWinners: 1, lotteryIntervalHours: 720, lotteryAmount: "1", nextLotteryTimestamp: new Date('2018-07-01T00:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });
      await tableAsserts.assertUserBalances({ account: CONSTANTS.HIVE_ENGINE_ACCOUNT, symbol: CONSTANTS.UTILITY_TOKEN, balance: '1500011.41552511', stake: '0' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', `{ "id": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lotteryWinners": 2, "lotteryIntervalHours": 3, "lotteryAmount": "15.7", "minedToken": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "tokenMiners": [{"symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "multiplier": 1}], "isSignedWithActiveKey": true }`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool(CONSTANTS.UTILITY_TOKEN_SYMBOL, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);

      await assertPool({id: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}:${CONSTANTS.UTILITY_TOKEN_SYMBOL}`, totalPower: '0', lotteryWinners: 2, lotteryIntervalHours: 3, lotteryAmount: "15.7", nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime()}, { inProgress: false, lastId: 0, tokenIndex: 0 });

      await tableAsserts.assertUserBalances({ account: CONSTANTS.HIVE_ENGINE_ACCOUNT, symbol: CONSTANTS.UTILITY_TOKEN, balance: '1500011.41552511', stake: '0' });

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not run basic lottery when inactive', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": false, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime(), active: false });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
  
      let res = (await fixture.database.getLatestBlockInfo());

      assert(res.virtualTransactions.length === 0);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
  
      await tableAsserts.assertNoErrorInLastBlock();

      res = (await fixture.database.getLatestBlockInfo());
      assert(res.virtualTransactions.length === 0);

      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T03:00:00.000Z').getTime(), active: true });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T03:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
  
      res = (await fixture.database.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '41.00000000', stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '10.00000000' });



      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run basic lottery', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "4000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '10.00000000' });

      await assertMiningPower('satoshi', 'TKN:TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:TKN', '10');
      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      let res = (await fixture.database.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '41.00000000', stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '10.00000000' });

      // run a few more times and count frequencies
      const winnerCount = { 'satoshi': 0, 'satoshi2': 0 };
      const lotteryDate = new Date('2018-06-01T01:00:00.000Z');
      for (let i = 0; i < 10; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        lotteryDate.setHours(lotteryDate.getHours() + i + 1);
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: lotteryDate.toISOString().replace('.000Z', ''),
          transactions,
        };
        await fixture.sendBlock(block);
  
        res = (await fixture.database.getLatestBlockInfo());
        virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');

        assert.ok(lotteryEvent, 'Expected to find miningLottery event');
        assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
        assert.equal(lotteryEvent.data.winners.length, 1);
        winnerCount[lotteryEvent.data.winners[0].winner] += 1;
      }
      assert.equal(Object.values(winnerCount).reduce((x,y) => x+y, 0), 10);
      assert(winnerCount['satoshi'] > winnerCount['satoshi2']);
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: (41 + winnerCount['satoshi']).toFixed(8), stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: winnerCount['satoshi2'].toFixed(8), stake: '10.00000000' });

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should run basic lottery with 2 tokenMiners', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "7000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "MTKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "MTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "MTKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "MTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "30", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "MTKN", "quantity": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "MTKN", "quantity": "20", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}, {"symbol": "MTKN", "multiplier": 4}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:MTKN,TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:MTKN,TKN');
      await assertTokenPool('MTKN', 'TKN:MTKN,TKN');

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.00000000', stake: '30.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '20.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'MTKN', balance: '75.00000000', stake: '5.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'MTKN', balance: '0', stake: '20.00000000' });

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '30');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '20');
      await assertPool({id: 'TKN:MTKN,TKN', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1 });

      // allow mining power update to resume
      await finishPowerUpdate('TKN:MTKN,TKN');

      await assertMiningPower('satoshi', 'TKN:MTKN,TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:MTKN,TKN', '100');
      await assertPool({ id: 'TKN:MTKN,TKN', totalPower: '150', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
  
      let res = (await fixture.database.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN:MTKN,TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi2");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '50.00000000', stake: '30.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '1.00000000', stake: '20.00000000' });

      // run a few more times and count frequencies
      const winnerCount = { 'satoshi': 0, 'satoshi2': 0 };
      const lotteryDate = new Date('2018-06-01T01:00:00.000Z');
      for (let i = 0; i < 20; i += 1) {
        refBlockNumber = fixture.getNextRefBlockNumber();
        transactions = [];
        transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));
        lotteryDate.setHours(lotteryDate.getHours() + i + 1);
        block = {
          refHiveBlockNumber: refBlockNumber,
          refHiveBlockId: 'ABCD1',
          prevRefHiveBlockId: 'ABCD2',
          timestamp: lotteryDate.toISOString().replace('.000Z', ''),
          transactions,
        };
        await fixture.sendBlock(block);
  
        res = (await fixture.database.getLatestBlockInfo());
        virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
        lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');

        assert.ok(lotteryEvent, 'Expected to find miningLottery event');
        assert.equal(lotteryEvent.data.poolId, 'TKN:MTKN,TKN');
        assert.equal(lotteryEvent.data.winners.length, 1);
        winnerCount[lotteryEvent.data.winners[0].winner] += 1;
      }
      assert.equal(Object.values(winnerCount).reduce((x,y) => x+y, 0), 20);
      assert(winnerCount['satoshi'] < winnerCount['satoshi2']);
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: (50 + winnerCount['satoshi']).toFixed(8), stake: '30.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: (1 + winnerCount['satoshi2']).toFixed(8), stake: '20.00000000' });

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should cap lotteries run', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();
      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "5200", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi2", "symbol": "TKN", "quantity": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKNB", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKNB", "tokenMiners": [{"symbol": "TKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKN:TKN", "active": true, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'setActive', '{ "id": "TKNB:TKN", "active": true, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertTokenPool('TKN', 'TKN:TKN');

      await tableAsserts.assertUserBalances({ account: 'harpagon', symbol: 'TKN', balance: '0.00000000', stake: '0' });
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '40.00000000', stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '10.00000000' });

      await assertMiningPower('satoshi', 'TKN:TKN', '50');
      await assertMiningPower('satoshi2', 'TKN:TKN', 0);
      await assertPool({ id: 'TKN:TKN', totalPower: '50', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 7, tokenIndex: 0 });
      await assertPool({ id: 'TKNB:TKN', totalPower: '0', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 0, tokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await assertMiningPower('satoshi2', 'TKN:TKN', '10');
      await assertPool({ id: 'TKN:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });
      await assertPool({ id: 'TKNB:TKN', totalPower: '0', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 0, tokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await assertMiningPower('satoshi', 'TKNB:TKN', '50');
      await assertMiningPower('satoshi2', 'TKNB:TKN', 0);
      await assertPool({ id: 'TKNB:TKN', totalPower: '50', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: true, lastId: 7, tokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await assertMiningPower('satoshi2', 'TKNB:TKN', '10');
      await assertPool({ id: 'TKNB:TKN', totalPower: '60', nextLotteryTimestamp: new Date('2018-06-01T01:00:00.000Z').getTime() }, { inProgress: false, lastId: 0, tokenIndex: 0 });

      let res = (await fixture.database.getLatestBlockInfo());
      let virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      assert(virtualEventLog.events.filter(x => x.event === 'miningLottery').length === 1, 'Expected 1 miningLottery');
      let lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKN:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKN', balance: '41.00000000', stake: '50.00000000' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKN', balance: '0', stake: '10.00000000' });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      res = (await fixture.database.getLatestBlockInfo());
      virtualEventLog = JSON.parse(res.virtualTransactions[0].logs);
      assert(virtualEventLog.events.filter(x => x.event === 'miningLottery').length === 1, 'Expected only 1 miningLottery');
      lotteryEvent = virtualEventLog.events.find(x => x.event === 'miningLottery');
      assert.ok(lotteryEvent, 'Expected to find miningLottery event');
      assert.equal(lotteryEvent.data.poolId, 'TKNB:TKN');
      assert.equal(lotteryEvent.data.winners.length, 1);
      assert.equal(lotteryEvent.data.winners[0].winner, "satoshi");
      assert.equal(lotteryEvent.data.winners[0].winningAmount, "1.00000000");

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TKNB', balance: '1.00000000', stake: '0' });
      await tableAsserts.assertUserBalances({ account: 'satoshi2', symbol: 'TKNB' }); // no balance

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not create nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"badtype", "type":"number", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"badequip", "type":"number", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"badminingPower", "type":"number", "isReadOnly":false }'));

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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": 1}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": 2}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "notype"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "badtype"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "properties": [{"op": "ADD"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": {}}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": []}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [1,2,3,4,5]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "JAZZ"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "ADD", "name": "12345678901234567", "bad": 1}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5"]}, "properties": [{"op": "ADD", "name": "1234567890123456", "bad": 1}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["1.0", "2.5", "3"]}, "properties": [{"op": "ADD", "name": "1234567890123456"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["blah"]}, "properties": [{"op": "ADD", "name": "1234567890123456"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "100.1"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": "1"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": 1}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "none"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "NOTKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": 0, "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "noequip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "badequip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": 0}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "nominingPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "badminingPower"}, "isSignedWithActiveKey": true }'));

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
      assertError(txs[0], 'nftTokenMiner invalid');
      assertError(txs[1], 'nftTokenMiner must have delegation enabled');
      // 2 enables delegation
      assertError(txs[3], 'typeField must be a string');
      assertError(txs[4], 'typeField must be a string');
      assertError(txs[5], 'nftTokenMiner must have string type property');
      assertError(txs[6], 'nftTokenMiner must have string type property');
      assertError(txs[7], 'invalid nftTokenMiner typeMap');
      assertError(txs[8], 'invalid nftTokenMiner properties');
      assertError(txs[9], 'nftTokenMiner properties size must be between 1 and 4');
      assertError(txs[10], 'nftTokenMiner properties size must be between 1 and 4');
      assertError(txs[11], 'nftTokenMiner properties op should be ADD or MULTIPLY');
      assertError(txs[12], 'nftTokenMiner properties name should be a string of length <= 16');
      assertError(txs[13], 'nftTokenMiner properties field invalid');
      assertError(txs[14], 'nftTokenMiner typeConfig length mismatch');
      assertError(txs[15], 'nftTokenMiner typeConfig invalid');
      assertError(txs[16], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[17], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[18], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[19], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[20], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[21], 'nftTokenMiner properties burnChange symbol not found');
      assertError(txs[22], 'equipField must be a string');
      assertError(txs[23], 'nftTokenMiner must have string equip property');
      assertError(txs[24], 'nftTokenMiner must have string equip property');
      assertError(txs[25], 'miningPowerField must be a string');
      assertError(txs[26], 'nftTokenMiner must have string miningPower property');
      assertError(txs[27], 'nftTokenMiner must have string miningPower property');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should create nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNB", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNC", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKND", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      
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
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKNB", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKNC", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKND", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));

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
      let txs = res.transactions;

      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertPool({id: 'TKNB:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TKNB:TEST-TKN:TSTNFT');
      await assertPool({id: 'TKNC:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TKNC:TEST-TKN:TSTNFT');
      await assertPool({id: 'TKND:TEST-TKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TKND:TEST-TKN:TSTNFT');

      let eventLog = JSON.parse(res.transactions[0].logs);
      let createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN::TSTNFT');

      eventLog = JSON.parse(res.transactions[1].logs);
      createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TEST-TKN:TEST-TKN:TSTNFT');

      eventLog = JSON.parse(res.transactions[2].logs);
      createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TKNB:TEST-TKN:TSTNFT');

      eventLog = JSON.parse(res.transactions[3].logs);
      createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TKNC:TEST-TKN:TSTNFT');

      eventLog = JSON.parse(res.transactions[4].logs);
      createPoolEvent = eventLog.events.find(x => x.event === 'createPool');
      assert.equal(createPoolEvent.data.id, 'TKND:TEST-TKN:TSTNFT');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

  it('should update nft mining power on delegation updates', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, {'account': 'mining', 'ownedBy': 'c', 'undelegateAt': 1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '3', {0: '2', 1: '1.5'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, {'account': 'mining', 'ownedBy': 'c'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '6.075', {0: '3', 1: '2.025'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '6.075'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["4"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u', "undelegateAt":1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

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

      await assertNftInstance('satoshi2', 'TSTNFT', 4, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, {"account":"mining","ownedBy":"c","undelegateAt":1527984000000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await assertNftInstance('satoshi', 'TSTNFT', 1, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update nft mining power on delegation updates for equip field', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip"}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, {'account': 'mining', 'ownedBy': 'c', 'undelegateAt': 1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, {'account': 'mining', 'ownedBy': 'c'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["4"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u', "undelegateAt":1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

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

      await assertNftInstance('satoshi2', 'TSTNFT', 4, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, {"account":"mining","ownedBy":"c","undelegateAt":1527984000000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await assertNftInstance('satoshi', 'TSTNFT', 1, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', null);
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining power on equip updates for equip field', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "harpagon", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull", "equip": "satoshi"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "harpagon", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "satoshi"}}]}`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('harpagon', 'TSTNFT', 1);
      await assertNftInstance('harpagon', 'TSTNFT', 2);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '3', {0: '2', 1: '1.5'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "harpagon", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "equip": "satoshi"}}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 3);
      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "equip": "satoshi"}}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '6.075', {0: '3', 1: '2.025'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '6.075'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "equip": "" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "%BAD_ACCOUNT" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 1);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      // Issue already equipped, but does not affect yet
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "harpagon", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull", "equip": "satoshi"}}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 5, null, { "equip": "satoshi" });

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      // Corner case of issue already equipped, and setting equip to same thing does not do anything
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "equip": "satoshi" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 5, null, { "equip": "satoshi" });
      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      // Corner case of issue already equipped, and setting equip to different account does not affect
      // old account and equips new account
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "equip": "satoshi2" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 5, null, { "equip": "satoshi2" });
      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', '3', {"0":"2","1":"1.5"});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      // Ensure that repeated equips to the same account do nothing
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "equip": "satoshi2" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 5, null, { "equip": "satoshi2" });
      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {0: '-1', 1: '0.9'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', '3', {"0":"2","1":"1.5"});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      // Swapping equips correctly adjusts both balances
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "equip": "satoshi" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('harpagon', 'TSTNFT', 5, null, { "equip": "satoshi" });
      await assertMiningPower('satoshi', 'TKN::TSTNFT', '1.35', {0: '1', 1: '1.35'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', '0', {"0":"0","1":"1"});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '1.35'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining power on delegation updates for miningPower field', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "miningPower": "1000" }}]}`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, {'account': 'mining', 'ownedBy': 'c', 'undelegateAt': 1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '3', {0: '2', 1: '1.5', '_miningPower': '0'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "miningPower": "10000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, {'account': 'mining', 'ownedBy': 'c'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10001.35', {0: '1', 1: '1.35', '_miningPower': '10000'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "miningPower": "100000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '110006.075', {0: '3', 1: '2.025', '_miningPower': '110000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '110006.075'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["4"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u', "undelegateAt":1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10001.35', {0: '1', 1: '1.35', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.35'});

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

      await assertNftInstance('satoshi2', 'TSTNFT', 4, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10001.35', {0: '1', 1: '1.35', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, {"account":"mining","ownedBy":"c","undelegateAt":1527984000000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '9999.1', {0: '-1', 1: '0.9', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '9999.1'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await assertNftInstance('satoshi', 'TSTNFT', 1, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '9999.1', {0: '-1', 1: '0.9', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '9999.1'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining power on delegation updates for miningPower field without type prop', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "miningPower": "1000" }}]}`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, {'account': 'mining', 'ownedBy': 'c', 'undelegateAt': 1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '0', {'_miningPower': '0'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '0'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "miningPower": "10000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, {'account': 'mining', 'ownedBy': 'c'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10000', {'_miningPower': '10000'}, {"1":{"type":"bull","extraMiningPower":"0"},"3":{"type":"bear","extraMiningPower":"10000"}});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10000'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "miningPower": "100000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '110000', {'_miningPower': '110000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '110000'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["4"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, {'account': 'satoshi', 'ownedBy': 'u', "undelegateAt":1527897600000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10000', {'_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10000'});

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

      await assertNftInstance('satoshi2', 'TSTNFT', 4, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10000', {'_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10000'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, {"account":"mining","ownedBy":"c","undelegateAt":1527984000000});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10000', {'_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10000'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-03T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await assertNftInstance('satoshi', 'TSTNFT', 1, undefined);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10000', {'_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10000'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining power on equip updates for miningPower field', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', `{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}": "0"} }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 720, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bull": ["2.0", "1.5"], "bear": ["-1.0", "0.9"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "satoshi" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "miningPower": "1000" }}]}`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, null, {'equip': 'satoshi'});
      await assertNftInstance('satoshi', 'TSTNFT', 2, null);

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '3', {0: '2', 1: '1.5', '_miningPower': '0'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '3'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "miningPower": "10000", "equip": "satoshi" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 3, null, {'equip': 'satoshi'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10001.35', {0: '1', 1: '1.35', '_miningPower': '10000'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties": {"type": "bull"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "equip": "satoshi", "miningPower": "100000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, null, {'equip': 'satoshi'});

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '110006.075', {0: '3', 1: '2.025', '_miningPower': '110000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '110006.075'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "miningPower": "200000", "equip": "" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi2', 'TSTNFT', 4, null, { 'equip': '' });

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '10001.35', {0: '1', 1: '1.35', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', null);
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.35'});

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "satoshi2", "miningPower": "-1" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftInstance('satoshi', 'TSTNFT', 1, null, { 'equip': 'satoshi2' });

      await assertMiningPower('satoshi', 'TKN::TSTNFT', '9999.1', {0: '-1', 1: '0.9', '_miningPower': '10000'});
      await assertMiningPower('satoshi2', 'TKN::TSTNFT', '2', {0: '2', 1: '1.5', '_miningPower': '-1'});
      await assertPool({id: 'TKN::TSTNFT', totalPower: '10001.1'});

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TESTTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TESTTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TESTTKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertPool({id: 'TESTTKN::TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TESTTKN::TSTNFT');
      await assertPool({id: 'TESTTKN:TESTTKN:TSTNFT', totalPower: '0'});
      await assertNftTokenPool('TSTNFT', 'TESTTKN:TESTTKN:TSTNFT');

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT2", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type2", "typeMap": "bad", "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": "bad", "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"car": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "100.1"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": "1"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": 1}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TKN", "quantity": "none"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "NOTKN", "quantity": "1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "other"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "other"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "other", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "other"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'updatePool', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "2.0"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip"}, "isSignedWithActiveKey": true }'));

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

      assertError(txs[0], 'cannot change nftTokenMiner token');
      assertError(txs[1], 'cannot change nftTokenMiner token');
      assertError(txs[2], 'cannot change nftTokenMiner token');
      assertError(txs[3], 'cannot change nftTokenMiner typeField');
      assertError(txs[4], 'invalid nftTokenMiner typeMap');
      assertError(txs[5], 'typeConfig types must be a superset of old typeConfig types');
      assertError(txs[6], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[7], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[8], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[9], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[10], 'nftTokenMiner properties burnChange invalid');
      assertError(txs[11], 'nftTokenMiner properties burnChange symbol not found');
      assertError(txs[12], 'cannot change nftTokenMiner equipField');
      assertError(txs[13], 'cannot change nftTokenMiner miningPowerField');
      assertError(txs[14], 'cannot change nftTokenMiner equipField');
      assertError(txs[15], 'cannot change nftTokenMiner equipField');
      assertError(txs[16], 'cannot change nftTokenMiner miningPowerField');
      assertError(txs[17], 'cannot change nftTokenMiner miningPowerField');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining pool', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TEST.TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TEST.TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');
      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertTokenPool('TEST.TKN', 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TEST.TKN', balance: '50.00000000', stake: '50.00000000' });

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1, nftTokenIndex: 0 });

      // allow mining power update to resume
      await finishPowerUpdate('TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-100", "0.1"], "bull": ["50", "10"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50');
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50'}, { inProgress: true, lastId: 0, tokenIndex: 1, nftTokenIndex: 0 });

      // allow mining power update to resume
      await finishPowerUpdate('TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '0', {0: '-50', 1: '1'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '0'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      // change ops
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1", "1"], "bull": ["100", "1.5", "1"]}, "properties": [{"op": "MULTIPLY", "name": "power"}, {"op": "ADD", "name": "boost"}, {"op": "ADD", "name": "boost2"}]}, "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '16000', {0: '5000', 1: '1.6', 2: '2'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '16000'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should handle nft delegation change during update', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0", "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0.75'}, { inProgress: true, lastId: 2, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '1.125', {0: '2', 1: '0.5625'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '1.125'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others. make sure this op is processed
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '0', {0: '0', 1: '0.375'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '0'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
 
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '52.5', {0: '350', 1: '0.15'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '52.5'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["5"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '146.25', {0: '650', 1: '0.225'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '146.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should handle nft delegation change during update with mining power field', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0", "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear", "miningPower": "1000"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull", "miningPower": "10000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear", "miningPower": "100000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull", "miningPower": "1000000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '1000.75', {0: '1', 1: '0.75', '_miningPower': '1000'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '1000.75'}, { inProgress: true, lastId: 2, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["3"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["4"]} ] }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '111001.125', {0: '2', 1: '0.5625', "_miningPower": "111000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '111001.125'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others. make sure this op is processed
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["1"]} ], "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '111000', {0: '0', 1: '0.375', "_miningPower":"111000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '111000'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
 
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'undelegate', '{ "nfts": [ {"symbol": "TSTNFT", "ids": ["2"]} ], "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "miningPower": "2000" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "miningPower": "20000" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "miningPower": "200000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '220052.5', {0: '350', 1: '0.15', "_miningPower": "220000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '220052.5'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["5"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "miningPower": "2000000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '2220146.25', {0: '650', 1: '0.225', "_miningPower": "2220000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '2220146.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should handle nft equip change during update with equip and miningPower fields', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0", "maxBalancesProcessedPerBlock": 2, "processQueryLimit": 1, "maxLotteriesPerBlock": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"equip", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"miningPower", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear", "miningPower": "1000"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull", "miningPower": "10000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear", "miningPower": "100000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull", "miningPower": "1000000"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "satoshi" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "equip": "satoshi" }}]}`));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN::TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, null, {'equip': 'satoshi'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, null, {'equip': 'satoshi'});

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '1000.75', {0: '1', 1: '0.75', '_miningPower': '1000'});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '1000.75'}, { inProgress: true, lastId: 2, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "equip": "satoshi" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "equip": "satoshi" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '111001.125', {0: '2', 1: '0.5625', "_miningPower": "111000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '111001.125'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others. make sure this op is processed
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "1", "properties": { "equip": "" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '111000', {0: '0', 1: '0.375', "_miningPower":"111000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '111000'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
 
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN::TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["50", "0.1"], "bull": ["300", "1.5"]}, "properties": [{"op": "ADD", "name": "power"}, {"op": "MULTIPLY", "name": "boost"}], "equipField": "equip", "miningPowerField": "miningPower"}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "2", "properties": { "equip": "", "miningPower": "2000" }}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "3", "properties": { "miningPower": "20000"}}]}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "4", "properties": { "miningPower": "200000" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '220052.5', {0: '350', 1: '0.15', "_miningPower": "220000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '220052.5'}, { inProgress: true, lastId: 4, tokenIndex: 0, nftTokenIndex: 0 });
      
      // allow mining power update to resume and add others
      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'setProperties', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "nfts": [ { "id": "5", "properties": { "miningPower": "2000000", "equip": "satoshi" }}]}`));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };
      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      await assertMiningPower('satoshi', 'TEST-TKN::TSTNFT', '2220146.25', {0: '650', 1: '0.225', "_miningPower": "2220000"});
      await assertMiningPower('satoshi2', 'TEST-TKN::TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN::TSTNFT', totalPower: '2220146.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should not update nft mining pool with burn', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TEST.TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableStaking', '{ "symbol": "TEST.TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'enableDelegation', '{ "symbol": "TEST.TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TEST.TKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'issue', '{ "symbol": "TEST.TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TEST.TKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TEST.TKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TEST-TKN:TEST-TKN:TSTNFT');
      await assertTokenPool('TEST.TKN', 'TEST-TKN:TEST-TKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TEST.TKN', balance: '50.00000000', stake: '50.00000000' });

      // allow to finish update
      await finishPowerUpdate('TEST-TKN:TEST-TKN:TSTNFT');

      await assertMiningPower('satoshi', 'TEST-TKN:TEST-TKN:TSTNFT', '50.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TEST-TKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TEST-TKN:TEST-TKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": 0, "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": 0, "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": 0, "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "null", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "Infinity", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "NO", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "none", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "0.000000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updatePool', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TEST.TKN", "tokenMiners": [{"symbol": "TEST.TKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost", "burnChange": {"symbol": "TEST.TKN", "quantity": "0.1"}}]}, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "-0.491", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TEST-TKN:TEST-TKN:TSTNFT", "type": "bear", "propertyName": "boost", "changeAmount": "100", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      
      let res = await fixture.database.getLatestBlockInfo();
      let txs = res.transactions;

      assertError(txs[0], 'invalid params');
      assertError(txs[2], 'invalid params');
      assertError(txs[3], 'invalid params');
      assertError(txs[4], 'invalid params');
      assertError(txs[5], 'invalid params');
      assertError(txs[6], 'you must use a custom_json signed with your active key');
      assertError(txs[7], 'pool id not found');
      assertError(txs[8], 'property not enabled for burn change');
      assertError(txs[9], 'type not found');
      assertError(txs[10], 'fee precision mismatch for amount 1e-10');
      assertError(txs[11], 'you must have enough tokens to cover the update fee of 1 TEST.TKN');
      assertError(txs[13], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');
      assertError(txs[14], 'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100');

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should update nft mining pool with burn', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "2100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TESTTKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TESTTKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TESTTKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'mining', 'updateParams', '{ "poolCreationFee": "0", "poolUpdateFee": "0" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'nft', 'updateParams', '{ "nftCreationFee": "0", "enableDelegationFee": "0", "dataPropertyCreationFee": "0", "nftIssuanceFee": {"TESTTKN": "0"} }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 1 }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"type", "type":"string", "isReadOnly":false }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TESTTKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "mining", "toType": "contract", "nfts": [ {"symbol":"TSTNFT", "ids": ["1"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi2", "toType": "user", "feeSymbol": "TESTTKN", "properties": {"type": "bear"}}`));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi2', 'nft', 'delegate', '{ "isSignedWithActiveKey":true, "to": "satoshi", "toType": "user", "nfts": [ {"symbol":"TSTNFT", "ids": ["2"]} ] }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'tokens', 'issue', '{ "symbol": "TESTTKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TESTTKN", "quantity": "50", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to": "satoshi", "toType": "user", "feeSymbol": "TESTTKN", "properties": {"type": "bull"}}'));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'harpagon', 'mining', 'createPool', '{ "lotteryWinners": 1, "lotteryIntervalHours": 1, "lotteryAmount": "1", "minedToken": "TESTTKN", "tokenMiners": [{"symbol": "TESTTKN", "multiplier": 1}], "nftTokenMiner": {"symbol": "TSTNFT", "typeField": "type", "typeMap": {"bear": ["-1.0", "0.5"], "bull": ["2.0", "1.5"]}, "properties": [{"op": "ADD", "name": "power", "burnChange": {"symbol": "TESTTKN", "quantity": "0.1"}}, {"op": "MULTIPLY", "name": "boost"}]}, "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await assertNftTokenPool('TSTNFT', 'TESTTKN:TESTTKN:TSTNFT');
      await assertTokenPool('TESTTKN', 'TESTTKN:TESTTKN:TSTNFT');

      await assertNftInstance('satoshi', 'TSTNFT', 1, {'account': 'mining', 'ownedBy': 'c'});
      await assertNftInstance('satoshi2', 'TSTNFT', 2, {'account': 'satoshi', 'ownedBy': 'u'});
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TESTTKN', balance: '50.00000000', stake: '50.00000000' });

      // allow to finish update
      await finishPowerUpdate('TESTTKN:TESTTKN:TSTNFT');

      await assertMiningPower('satoshi', 'TESTTKN:TESTTKN:TSTNFT', '50.75', {0: '1', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TESTTKN:TEST-TKN:TSTNFT', undefined);
      await assertPool({id: 'TESTTKN:TESTTKN:TSTNFT', totalPower: '50.75'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "10", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();

      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TESTTKN', balance: '49.00000000', stake: '50.00000000' });
  
      // allow to finish update
      await finishPowerUpdate('TESTTKN:TESTTKN:TSTNFT');

      await assertMiningPower('satoshi', 'TESTTKN:TESTTKN:TSTNFT', '58.25', {0: '11', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TESTTKN:TESTTKN:TSTNFT', undefined);
      await assertPool({id: 'TESTTKN:TESTTKN:TSTNFT', totalPower: '58.25'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), 'satoshi', 'mining', 'changeNftProperty', '{ "id": "TESTTKN:TESTTKN:TSTNFT", "type": "bear", "propertyName": "power", "changeAmount": "-5", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await fixture.sendBlock(block);

      await tableAsserts.assertNoErrorInLastBlock();
  
      await tableAsserts.assertUserBalances({ account: 'satoshi', symbol: 'TESTTKN', balance: '48.50000000', stake: '50.00000000' });

      // allow to finish update
      await finishPowerUpdate('TESTTKN:TESTTKN:TSTNFT');

      await assertMiningPower('satoshi', 'TESTTKN:TESTTKN:TSTNFT', '54.5', {0: '6', 1: '0.75'});
      await assertMiningPower('satoshi2', 'TESTTKN:TESTTKN:TSTNFT', undefined);
      await assertPool({id: 'TESTTKN:TESTTKN:TSTNFT', totalPower: '54.5'}, { inProgress: false, lastId: 0, tokenIndex: 0, nftTokenIndex: 0 });
      
      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });
  });

  it('should add index', (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tokensContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(tokenfundsContractPayload)));
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      let contractCollection = await fixture.database.getContractCollection("mining", "mining_miningPower");
      let indexInfo = await contractCollection.indexInformation();
      assert(!indexInfo['byPoolIdAndAccount']);

      refBlockNumber = fixture.getNextRefBlockNumber();
      transactions = [];
      transactions.push(new Transaction(refBlockNumber, fixture.getNextTxId(), CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(contractPayload)));

      block = {
        refHiveBlockNumber: refBlockNumber,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await fixture.sendBlock(block);
      await tableAsserts.assertNoErrorInLastBlock();

      contractCollection = await fixture.database.getContractCollection("mining", "mining_miningPower");
      indexInfo = await contractCollection.indexInformation();
      assert(indexInfo['byPoolIdAndAccount']);

      resolve();
    })
      .then(() => {
        fixture.tearDown();
        done();
      });

  });

});
