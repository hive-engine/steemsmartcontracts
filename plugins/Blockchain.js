const axios = require('axios');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const { Database } = require('../libs/Database');
const { Bootstrap } = require('../contracts/bootstrap/Bootstrap');

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Blockchain.constants');

const actions = {};

const ipc = new IPC(PLUGIN_NAME);
let database = null;
let compareDatabase = null;
let javascriptVMTimeout = 0;
let producing = false;
let stopRequested = false;
let enableHashVerification = false;

const createGenesisBlock = async (payload) => {
  // check if genesis block hasn't been generated already
  let genesisBlock = await database.getBlockInfo(0);

  if (!genesisBlock) {
    // insert the genesis block
    const { chainId, genesisHiveBlock } = payload;
    const genesisTransactions = await Bootstrap.getBootstrapTransactions(genesisHiveBlock);
    genesisTransactions.unshift(new Transaction(genesisHiveBlock, 0, 'null', 'null', 'null', JSON.stringify({ chainId, genesisHiveBlock })));

    genesisBlock = new Block('2018-06-01T00:00:00', 0, '', '', genesisTransactions, -1, '0');
    await genesisBlock.produceBlock(database, javascriptVMTimeout);

    await database.insertGenesisBlock(genesisBlock);
  }
};

function getLatestBlockMetadata() {
  return database.getLatestBlockMetadata();
}

function addBlock(block) {
  return database.addBlock(block);
}

let mainBlock = null;

const blockData = (t) => ({ refHiveBlockNumber: t.refHiveBlockNumber, transactionId: t.transactionId, sender: t.sender, contract: t.contract, payload: t.payload, executedCodeHash: t.executedCodeHash, logs: t.logs, hash: t.hash, databaseHash: t.databaseHash });
function compareBlocks(block1, block2) {
  return JSON.stringify(block1.transactions.map(blockData).concat(block1.virtualTransactions.map(blockData))) === JSON.stringify(block2.transactions.map(blockData).concat(block2.virtualTransactions.map(blockData)));
}

async function getCompareBlock(blockNumber) {
    let compareBlock = await compareDatabase.getBlockInfo(blockNumber);
    if (compareBlock) return compareBlock;
    try {
      compareBlock = (await axios({
        url: 'https://api.hive-engine.com/rpc/blockchain',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        data: {
          jsonrpc: '2.0', id: 10, method: 'getBlockInfo', params: { blockNumber },
        },
      })).data.result;
      if (compareBlock) return compareBlock;
    } catch (error) {
      console.error(error);
    }
    console.log("Retry fetch for primary node sidechain block " + blockNumber);
    await new Promise(resolve => setTimeout(resolve, 3000));
    return getCompareBlock(blockNumber);
}

// produce all the pending transactions, that will result in the creation of a block
async function producePendingTransactions(
  refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, transactions, timestamp,
) {
  const previousBlock = await getLatestBlockMetadata();
  if (previousBlock) {
    // skip block if it has been parsed already
    if (refHiveBlockNumber <= previousBlock.refHiveBlockNumber) {
      // eslint-disable-next-line no-console
      console.warn(`skipping Hive block ${refHiveBlockNumber} as it has already been parsed`);
      return;
    }

    const newBlock = new Block(
      timestamp,
      refHiveBlockNumber,
      refHiveBlockId,
      prevRefHiveBlockId,
      transactions,
      previousBlock.blockNumber,
      previousBlock.hash,
      previousBlock.databaseHash,
    );

    const session = database.startSession();

    mainBlock = !enableHashVerification ? null : (mainBlock && mainBlock.blockNumber === newBlock.blockNumber ? mainBlock : await getCompareBlock(newBlock.blockNumber));
    try {
      await session.withTransaction(async () => {
        await newBlock.produceBlock(database, javascriptVMTimeout, mainBlock);

        if (newBlock.transactions.length > 0 || newBlock.virtualTransactions.length > 0) {
          if (mainBlock && newBlock.hash) {
            console.log(`Sidechain Block ${mainBlock.blockNumber}, Main db hash: ${mainBlock.databaseHash}, Main block hash: ${mainBlock.hash}, This db hash: ${newBlock.databaseHash}, This block hash: ${newBlock.hash}`); // eslint-disable-line no-console

            if (mainBlock.databaseHash !== newBlock.databaseHash || mainBlock.hash !== newBlock.hash) {
            //if (!compareBlocks(mainBlock, newBlock)) {
              throw new Error(`Block mismatch with api \nMain: ${JSON.stringify(mainBlock, null, 2)}, \nThis: ${JSON.stringify(newBlock, null, 2)}`);
            }
          }

          await addBlock(newBlock);
        }
      });
    } catch (e) {
      console.error(e); // eslint-disable-line no-console
      throw e;
    } finally {
      await database.endSession();
    }
  } else {
    throw new Error('block not found');
  }
}

const produceNewBlockSync = async (block, callback = null) => {
  if (stopRequested) return;
  producing = true;
  // the stream parsed transactions from the Hive blockchain
  const {
    refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId,
    transactions, timestamp, virtualTransactions, replay,
  } = block;
  const newTransactions = [];

  transactions.forEach((transaction) => {
    const finalTransaction = transaction;

    newTransactions.push(new Transaction(
      finalTransaction.refHiveBlockNumber,
      finalTransaction.transactionId,
      finalTransaction.sender,
      finalTransaction.contract,
      finalTransaction.action,
      finalTransaction.payload,
    ));
  });

  // if there are transactions pending we produce a block
  if (newTransactions.length > 0
     || (virtualTransactions && virtualTransactions.length > 0) || replay) {
    await producePendingTransactions(
      refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, newTransactions, timestamp,
    );
  }
  producing = false;

  if (callback) callback();
};

// when stopping, we wait until the current block is produced
function stop(callback) {
  stopRequested = true;
  if (producing) {
    setTimeout(() => stop(callback), 500);
  } else {
    stopRequested = false;
    if (database) database.close();
    callback();
  }
}

const init = async (conf, callback) => {
  const {
    databaseURL,
    databaseName,
  } = conf;
  javascriptVMTimeout = conf.javascriptVMTimeout; // eslint-disable-line prefer-destructuring
  enableHashVerification = conf.enableHashVerification; // eslint-disable-line prefer-destructuring

  database = new Database();
  await database.init(databaseURL, databaseName);
  compareDatabase = new Database();
  await compareDatabase.init(databaseURL, 'hsctest');

  await createGenesisBlock(conf);

  callback(null);
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === 'init') {
    init(payload, (res) => {
      console.log('successfully initialized'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === 'stop') {
    stop(() => {
      console.log('successfully stopped'); // eslint-disable-line no-console
      ipc.reply(message);
    });
  } else if (action === PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC) {
    produceNewBlockSync(payload, () => {
      ipc.reply(message);
    });
  } else if (action && typeof actions[action] === 'function') {
    ipc.reply(message, actions[action](payload));
  } else {
    ipc.reply(message);
  }
});

module.exports.producePendingTransactions = producePendingTransactions;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
