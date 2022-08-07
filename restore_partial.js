/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/**
 * Script for helping to restore / repair hive-engine node databases. The restore mode will simply drop the
 * existing database and do a full restore.
 * The repair mode will delete all invalid blocks / transactions and drop all other collections and restore the
 * last valid state using a light node snapshot.
 *
 * These are the different modes:
 * - FULL node:
 *   - Restore by executing `node restore_partial.js`     (~30-60 minutes)
 *   - Drop    by executing `node restore_partial.js -d -s https://snap.primersion.com/` (~6 hours)
 * - LIGHT node:
 *   - Drop    by executing `node restore_partial.js -d`  (~30-60 minutes)
 *   - Restore is not supported as dropping is faster
 * */

require('dotenv').config();
const program = require('commander');
const axios = require('axios');
const fs = require('fs-extra');
const { exec } = require('child_process');
const conf = require('./config');
const { Database } = require('./libs/Database');

program
  .option('-n, --node [url]', 'compare with given node', 'https://api.hive-engine.com/rpc')
  .option('-a, --archive [archive]', 'archive to restore')
  .option('-s, --snapshot-url [url]', 'base directory of light node snapshots to download', 'https://snap.primersion.com/light/')
  .option('-d, --drop', 'drops the database instead of trying to repair')
  .parse(process.argv);

const { node, snapshotUrl, drop } = program;
let { archive } = program;

let id = 1;

/**
 * Fetches the hive-engine block with the given @blockNumber from a hive-engine node.
 * @param blockNumber to fetch from the node
 * @param tries number of retries - will cancel after 3 tries
 * @returns {Promise<null|*|undefined>} the hive-engine block or null if the block doesn't exist or the request failed
 */
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

/**
 * Checks if the local hive-engine node has diverged and is in a different state than the reference @node.
 * @param chain connection to the chain mongo collection of the local hive-engine node
 * @param lightNode whether the node is a light node or not
 * @returns {Promise<number>} return -1 if the node is OK. -2 if the node is not caugth up or there was an error fetching a block or returns the diverged block number if one was found.
 */
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

/**
 * Fetches a list of snapshots from the given snapshotUrl, which should point to a server with directory listing enabled.
 * @param tries number of retries - will cancel after 3 tries
 * @returns {Promise<any|null|undefined>}
 */
async function fetchSnapshots(tries = 1) {
  try {
    return (await axios({
      url: snapshotUrl,
      method: 'GET',
    })).data;
  } catch (error) {
    if (tries >= 3) {
      console.error(error);
      return null;
    }
    console.log(`Attempt #${tries} failed, retrying...`);
    await new Promise(r => setTimeout(() => r(), 500));
    return fetchSnapshots(tries + 1);
  }
}

/**
 * Download the snapshot with the given @name from the given @url.
 * @param url to fetch the snapshot from
 * @param name of the snapshot
 * @returns {Promise<unknown>} returns a promise which will resolve once the download finished.
 */
async function downloadSnapshot(url, name) {
  return axios({
    method: 'GET',
    url,
    responseType: 'stream',
  }).then(response => new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(`./${name}`);
    response.data.pipe(writer);

    let error = null;
    writer.on('error', (err) => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on('close', () => {
      if (!error) {
        resolve(true);
      }
    });
  }));
}

/**
 * Downloads the latest snapshot from the @snapshotUrl, by first fetching all available snapshots and then download the
 * latest one to the current directory.
 * @returns {Promise<null|*>} blocks until the download finished and returns the downloaded snapshot name afterwards.
 */
async function downloadLatestSnapshot() {
  const snapshots = await fetchSnapshots();
  if (!snapshots || snapshots.length === 0) {
    console.log(`could not find any snapshots at ${snapshotUrl}`);
    return null;
  }
  console.log(`found ${snapshots.length} snapshots at ${snapshotUrl}`);
  const snapshot = snapshots[snapshots.length - 1];
  console.log(`downloading snapshot ${snapshot.name}`);

  await downloadSnapshot(`${snapshotUrl}/${snapshot.name}`, snapshot.name);
  console.log(`finished downloading ${snapshot.name}`);
  return snapshot.name;
}

/**
 * Updates the @startHiveBlock in the config.json file to the @newStartBlock.
 * @param newStartBlock to set in the config.json
 */
async function updateConfigJson(newStartBlock) {
  const config = fs.readJSONSync('./config.json');
  config.startHiveBlock = newStartBlock;
  fs.writeJSONSync('./config.json', config, { spaces: 4 });
  console.log(`set config.json startHiveBlock to ${newStartBlock}`);
}

/**
 * Executes the mongorestore command with the given archive. The restore will be executed in --quiet mode without
 * any log output if an existing database is restored as there will be a lot of duplicate key errors otherwise
 * for the already existing chain and transaction entries.
 * @param archiveName to use for restoring.
 */
async function execMongorestore(archiveName) {
  console.log(`starting restore using 'mongorestore --quiet --gzip --archive=${archiveName}'`);
  console.log('this will take 30 to 60 minutes without any log output...');

  exec(`mongorestore${drop ? '' : ' --quiet'} --gzip --archive=${archiveName}`, (error, stdout, stderr) => {
    if (error) {
      console.log('failed to restore');
      console.log(`error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.log('failed to restore');
      console.log(`stderr: ${stderr}`);
      return;
    }
    console.log(`stdout: ${stdout}`);
    console.log('finished restoring db. now restart your node');
  });
}

/**
 * Reverts the mongo database by deleting blocks and transactions after a given block and dropping all other collections.
 * @param database connection to mongo database
 * @param chain connection to the chain collection of the mongo database
 * @param divergentBlockNum the divergent block number
 * @param archiveHiveBlock the block number of the archive
 */
async function revertDatabase(database, chain, divergentBlockNum, archiveHiveBlock) {
  const divergentBlock = await chain.findOne({ _id: divergentBlockNum });
  const refHiveBlockDiff = divergentBlock.refHiveBlockNumber - archiveHiveBlock;
  const archiveBlockNum = divergentBlockNum - refHiveBlockDiff;

  const deleteFromBlock = Math.min(divergentBlockNum, archiveBlockNum) - 7; // delete 7 more blocks just to be on the safe side
  console.log(`Divergent block: ${divergentBlockNum} (${divergentBlock.refHiveBlockNumber}) Archive block: ${archiveBlockNum} (${archiveHiveBlock}) Restoring to: ${deleteFromBlock}`);

  const collectionsToRemove = await database.database.listCollections().toArray();
  for (const col of collectionsToRemove) {
    if (col.name === 'system.profile') {
      // skip
    } else if (col.name !== 'chain' && col.name !== 'transactions') {
      console.log(`removing collection ${col.name}`);
      await database.database.collection(col.name).drop();
    }
  }
  console.log(`removing blocks >= ${deleteFromBlock}`);
  await chain.deleteMany({ _id: { $gte: deleteFromBlock } });

  console.log(`removing transactions >= ${deleteFromBlock}`);
  await database.database.collection('transactions').deleteMany({ blockNumber: { $gte: deleteFromBlock } });
}

/**
 * Executes the restoring process by either dropping an existing databsae and doing a full restore or by checking
 * for a divergent state and trying to restore the database by removing invalid blocks / transactions and restoring
 * from a light node snapshot.
 */
async function restorePartial() {
  const {
    databaseURL,
    databaseName,
    lightNode,
  } = conf;

  if (lightNode && !drop) {
    console.log('Restoring a light node database is not supported. Please add the \'-d\' flag to completely restore your db.');
    return;
  }

  const database = new Database();
  await database.init(databaseURL, databaseName);
  const chain = database.database.collection('chain');

  let divergentBlockNum = Number.MAX_SAFE_INTEGER;
  if (!drop) {
    divergentBlockNum = await findDivergentBlock(chain, lightNode);
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
  }

  if (!archive || typeof archive !== 'string') {
    archive = await downloadLatestSnapshot();
    if (!archive) {
      console.log('start program with \'node restore_partial.js --archive <archive name>\' or add a valid snapshot-url');
      return;
    }
  }

  console.log(`restoring from archive ${archive}`);
  const archiveHiveBlock = +archive.match(/[0-9]+(?!.*[0-9])/)[0];
  if (drop) {
    console.log('dropping database');
    await database.database.dropDatabase();
  } else {
    await revertDatabase(database, chain, divergentBlockNum, archiveHiveBlock);
  }
  await database.close();

  await updateConfigJson(archiveHiveBlock);
  await execMongorestore(archive);
}

restorePartial();
