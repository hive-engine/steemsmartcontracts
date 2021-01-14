/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/**
 * Used to find which block the hashes diverged. */

require('dotenv').config();
const axios = require('axios');
const conf = require('./config');
const { Database } = require('./libs/Database');


let id = 1;

async function getBlock(blockNumber) {
  id += 1;
  return (await axios({
    url: 'https://api.hive-engine.com/rpc/blockchain',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0', id, method: 'getBlockInfo', params: { blockNumber },
    },
  })).data.result;
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
  let low = 3825661;
  let high = block._id;
  let mainBlock;
  while (high - low > 1) {
    console.log(`low ${low} high ${high}`);
    const check = Math.floor((low + high) / 2);
    mainBlock = await getBlock(check);
    block = await chain.findOne({ _id: check });
    if (mainBlock.databaseHash !== block.databaseHash) {
      high = check - 1;
    } else {
      low = check + 1;
    }
  }

  console.log(block);
  console.log(mainBlock);
  console.log(`divergent block id around${low} or ${high}`);
  database.close();
}

findDivergentBlock();
