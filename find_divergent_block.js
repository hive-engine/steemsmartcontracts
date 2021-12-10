/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/**
 * Used to find which block the hashes diverged. */

require('dotenv').config();
const program = require('commander');
const axios = require('axios');
const conf = require('./config');
const { Database } = require('./libs/Database');

program
  .option('-n, --node [url]', 'compare with given node', 'https://api.hive-engine.com/rpc')
  .parse(process.argv);

const { node } = program;

let id = 1;

async function getBlock(blockNumber) {
  id += 1;
  try {
    return (await axios({
      url: `${node}/blockchain`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      data: {
        jsonrpc: '2.0', id, method: 'getBlockInfo', params: { blockNumber },
      },
    })).data.result;
  } catch (error) {
    console.error(error);
    return null;
  }
}

const blockData = t => ({
  refHiveBlockNumber: t.refHiveBlockNumber,
  transactionId: t.transactionId,
  sender: t.sender,
  contract: t.contract,
  payload: t.payload,
  executedCodeHash: t.executedCodeHash,
  logs: t.logs,
});
function getCompareData(block) {
  return block;
  //return block.transactions.map(blockData).concat( block.virtualTransactions.map(blockData),);
}
function getCompareString(block) {
  return JSON.stringify(getCompareData(block));
}
function compareBlocks(block1, block2) {
  return getCompareString(block1) === getCompareString(block2);
}
function printBlockDiff(block, mainBlock) {
    // go through transactions, then virtual transactions, then overall hash
    if (!block) {
        console.log('This node missing block');
    } else if (!mainBlock) {
        console.log('Comparison node missing block');
    } else {
        for (let i = 0; i < block.transactions.length; i += 1) {
            const txString = JSON.stringify(block.transactions[i]);
            const mainTxString = JSON.stringify(mainBlock.transactions[i]);
            if (txString === mainTxString) {
                console.log(`Transaction ${i} matches`);
            } else {
                console.log(`Transaction ${i} mismatch: This: ${txString}, Main: ${mainTxString}`);
                return;
            }
        }
        for (let i = 0; i < block.virtualTransactions.length; i += 1) {
            const txString = JSON.stringify(block.virtualTransactions[i]);
            const mainTxString = JSON.stringify(mainBlock.virtualTransactions[i]);
            if (txString === mainTxString) {
                console.log(`Virtual Transaction ${i} matches`);
            } else {
                console.log(`Virtual Transaction ${i} mismatch: This: ${txString}, Main: ${mainTxString}`);
                return;
            }
        }
    }
}

async function findDivergentBlock() {
  const {
    databaseURL,
    databaseName,
  } = conf;
  const database = new Database();
  await database.init(databaseURL, databaseName);
  const chain = database.database.collection('chain');

  let block = (await chain.find().sort({ _id: -1 }).limit(1).toArray())[0];
  let low = 0;
  let high = block._id;
  const headBlock = high;
  let mainBlock;
  while (high - low >= 1) {
    console.log(`low ${low} high ${high}`);
    const check = Math.floor((low + high) / 2);
    mainBlock = await getBlock(check);
    if (!mainBlock) {
      break;
    }
    block = await chain.findOne({ _id: check });
    // Different comparison modes, uncomment desired comparison.
    if (mainBlock.hash !== block.hash) {
    // if (mainBlock.refHiveBlockNumber !== block.refHiveBlockNumber) {
    // if (!compareBlocks(mainBlock, block)) {
      high = check;
    } else {
      low = check + 1;
    }
  }
  mainBlock = await getBlock(high);
  block = await chain.findOne({ _id: high });

  if (high === headBlock && high - low <= 0) {
    console.log('ok');
  } else if (high !== low) {
    console.log('not caught up or error fetching block');
  } else {
    console.log('### high block');
    printBlockDiff(block, mainBlock);
    console.log(`divergent block id at ${high}`);
  }
  database.close();
}

findDivergentBlock();
