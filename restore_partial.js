/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/**
 * Used to restore a diverged database using a light node snapshot, by deleting all collections except for
 * chain and transactions and for them deleting blocks and transactions >= the diverged block and restoring
 * the collections using mongorestore and the lightnode snapshot. */

require('dotenv').config();
const program = require('commander');
const axios = require('axios');
const fs = require('fs-extra');
const conf = require('./config');
const { Database } = require('./libs/Database');

program
  .option('-n, --node [url]', 'compare with given node', 'https://api.hive-engine.com/rpc')
  .option('-a, --archive [archive]', 'archive to restore')
  .parse(process.argv);

const { node, archive } = program;

let id = 1;

async function getBlock(blockNumber, tries = 1) {
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
    if (tries >= 3) {
      console.error(error);
      return null;
    }
    console.log(`Attempt #${tries} failed, retrying...`);
    await new Promise(r => setTimeout(() => r(), 500));
    return getBlock(blockNumber, tries + 1);
  }
}

async function findDivergentBlock(chain, lightNode) {
  let block = (await chain.find().sort({ _id: -1 }).limit(1).toArray())[0];
  let mainBlock;
  let low = 0;
  if (lightNode) {
    const firstBlock = await chain.findOne({ blockNumber: { $gt: 0 } });
    if (firstBlock) {
      low = firstBlock.blockNumber;
    }
  }
  let high = block._id;
  const headBlock = high;
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
      high = check;
    } else {
      low = check + 1;
    }
  }
  if (high === headBlock && high - low <= 0) {
    return -1;
  }
  if (high !== low) {
    return -2;
  }
  return high;
}

async function restorePartial() {
  if (!archive || typeof archive !== 'string') {
    console.log('start program with \'node restore_partial.js --archive <archive name>\'');
    return;
  }
  const {
    databaseURL,
    databaseName,
    lightNode,
  } = conf;
  const database = new Database();
  await database.init(databaseURL, databaseName);
  const chain = database.database.collection('chain');

  const divergentBlockNum = await findDivergentBlock(chain, lightNode);
  if (divergentBlockNum === -1) {
    console.log('ok');
    await database.close();
    return;
  }
  if (divergentBlockNum === -2) {
    console.log('not caught up or error fetching block');
    await database.close();
    return;
  }
  console.log(`divergent block id at ${divergentBlockNum}`);
  console.log(`restoring from archive ${archive}`);
  const archiveHiveBlock = archive.match(/[0-9]+(?!.*[0-9])/)[0];
  const divergentBlock = await chain.findOne({ _id: divergentBlockNum });
  const refHiveBlockDiff = divergentBlock.refHiveBlockNumber - archiveHiveBlock;
  const archiveBlockNum = divergentBlockNum - refHiveBlockDiff;

  const deleteFromBlock = Math.min(divergentBlockNum, archiveBlockNum) - 7; // delete 7 more blocks just to be on the safe side
  console.log(`Divergent block: ${divergentBlockNum} (${divergentBlock.refHiveBlockNumber}) Archive block: ${archiveBlockNum} (${archiveHiveBlock}) Restoring to: ${deleteFromBlock}`);

  const collectionsToRemove = await database.database.listCollections().toArray();
  for (const col of collectionsToRemove) {
    if (col.name !== 'chain' && col.name !== 'transactions') {
      console.log(`removing collection ${col.name}`);
      await database.database.collection(col.name).drop();
    }
  }
  console.log(`removing blocks >= ${deleteFromBlock}`);
  await chain.deleteMany({ _id: { $gte: deleteFromBlock } });

  console.log(`removing transactions >= ${deleteFromBlock}`);
  await database.database.collection('transactions').deleteMany({ blockNumber: { $gte: deleteFromBlock } });

  const config = fs.readJSONSync('./config.json');
  config.startHiveBlock = archiveHiveBlock;
  fs.writeJSONSync('./config.json', config, { spaces: 4 });
  console.log(`set config.json startHiveBlock to ${archiveHiveBlock}`);

  console.log('all done - now run (takes 30 to 60 minutes):');
  console.log(`mongorestore --quiet --gzip --archive=${archive}`);
  await database.close();
}

restorePartial();
