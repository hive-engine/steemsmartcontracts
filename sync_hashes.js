/**
 * Used to sync local hashes to one that is running, which relies on having a window
 * in which we can nab all hashes before any of them change on a live node. This will sync
 * individual table hashes which are part of the block hashes, and can be corrupted if
 * the node is interrupted and processes a block partially. Adding transactions will mitigate
 * this issue, but the possibility is still there.
 *
 * Note that after this, you will need to also update the last block's hashes using mongo to
 * match.
 *
 * The process is
 * 1) Have local node up to date with main node, with hash verification off.
 * 2) run hash script
 * 3) turn on hash verification, which will cause the local node to stall
 * 4) update the last block's hashes to match the main node
 * 5) resume, and let it catch up, hashes will now be the same.
 */

require('dotenv').config();
const axios = require('axios');
const conf = require('./config');
const { Database } = require('./libs/Database');


let id = 1;

async function latestBlock() {
    return (await axios({ url: "https://api.hive-engine.com/rpc/blockchain",
        method: 'POST',
        headers: {
            'content-type': "application/json",
        },
        data: { 'jsonrpc': '2.0', 'id': ++id, 'method': 'getLatestBlockInfo' },
    })).data.result;
}

const contractNames = ['tokens', 'claimdrops', 'distribution', 'nftmarket', 'mining', 'packmanager', 'nft', 'airdrops', 'inflation', 'marketmaker', 'botcontroller', 'market', 'crittermanager', 'hivepegged'];

async function fetchContractHashes() {
    const tables = await Promise.all(contractNames.map(contractName => {
        return (async () => {
            const contract = (await axios({ url: "https://api.hive-engine.com/rpc/contracts",
                method: 'POST',
                headers: {
                    "content-type": "application/json",
                },
                data: {"jsonrpc": "2.0","id":++id,"method":"getContract","params":{"name": contractName}},
            })).data.result;
            return contract.tables;
        })();
    }));
    return tables;
}

async function getHashes() {
    const block = await latestBlock();
    console.log(block.blockNumber);
   
    const hashes1 = await fetchContractHashes();
    const hashes2 = await fetchContractHashes();
    const blockAfterFetch = await latestBlock();
    console.log(`Block before hash fetch: ${block.blockNumber}. Block after: ${blockAfterFetch.blockNumber}`);

    console.log(JSON.stringify(hashes1) === JSON.stringify(hashes2));
    if (block.blockNumber === blockAfterFetch.blockNumber && JSON.stringify(hashes1) === JSON.stringify(hashes2)) {
        // hash match, put into database
        const {
            databaseURL,
            databaseName,
        } = conf;
        const database = new Database();
        await database.init(databaseURL, databaseName);
        const contracts = database.database.collection('contracts');
        for (let i = 0; i < contractNames.length; i += 1) {
            const contract = contractNames[i];
            const contractInDb = await contracts.findOne({ _id: contract });
            console.log(`Checking contract ${contract}`);
            const tables = hashes1[i];
            const tableKeys = Object.keys(tables);
            for (let j = 0; j < tableKeys.length; j += 1) {
                const tableName = tableKeys[j];
                if (contractInDb.tables[tableName].hash !== tables[tableName].hash) {
                    console.log(`Would replace table hash for ${tableName} from ${contractInDb.tables[tableName].hash} to ${tables[tableName].hash}`);
                    contractInDb.tables[tableName].hash = tables[tableName].hash;
                    // uncomment to actually update the hashes of the contracts
                    //await contracts.updateOne({ _id: contract }, { $set: contractInDb });
                }
            }
        }
        database.close();
    }
}

getHashes();
