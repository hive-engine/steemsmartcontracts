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
  while (high - low > 1) {
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
      high = check - 1;
    } else {
      low = check + 1;
    }
  }
  mainBlock = await getBlock(high);
  block = await chain.findOne({ _id: high });

  if (high === headBlock && high - low <= 1) {
    console.log('ok');
  } else {
    console.log('### high block');
    console.log(getCompareData(block));
    console.log(getCompareData(mainBlock));
    if (low < high) {
      console.log('### low block');
      block = await chain.findOne({ _id: low });
      mainBlock = await getBlock(low);
      console.log(getCompareData(block));
      console.log(getCompareData(mainBlock));
    }
    console.log(`divergent block id around${low} or ${high}`);
    console.log('sampling for divergent blocks');
    for (let i = low; i < low + 1000; i += 1) {
      console.log(`${i}: ${compareBlocks(await getBlock(i), await chain.findOne({ _id: i }))}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  database.close();
}

findDivergentBlock();
