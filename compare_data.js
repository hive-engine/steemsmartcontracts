/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
require('dotenv').config();
const axios = require('axios');

let id = 1;

const contractNames = ['tokens', 'claimdrops', 'distribution', 'nftmarket', 'mining', 'packmanager', 'nft', 'airdrops', 'inflation', 'marketmaker', 'botcontroller', 'market', 'crittermanager', 'hivepegged'];

const node1 = 'https://api.hive-engine.com/rpc/contracts';
const node2 = 'http://127.0.0.1:5000/contracts';

async function getData(url, contract, tablekey, offset) {
  if (!tablekey) return null;
  const table = tablekey.split('_')[1];
  try {
    console.log(`getdata ${url}${contract}${table}${offset}`);
    id += 1;
    const data = (await axios({
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id,
        method: 'find',
        params: {
          contract, table, query: {}, offset,
        },
      },
    })).data.result;
    console.log(`done getdata ${url}${contract}${table}${offset}`);
    return data;
  } catch (error) {
    console.error(error);
  }
  return null;
}

async function compare(contractName) {
  console.log(`comparing ${contractName}`);
  id += 1;
  const contract = (await axios({
    url: 'https://api.hive-engine.com/rpc/contracts',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    data: {
      jsonrpc: '2.0', id, method: 'getContract', params: { name: contractName },
    },
  })).data.result;
  const tableNames = Object.keys(contract.tables);
  for (let i = 0; i < tableNames.length; i += 1) {
    const t = tableNames[i];
    let offset = 0;
    console.log(`comparing ${contractName}: ${t}`);
    let done = false;
    while (!done) {
      const data1 = await getData(node1, contractName, t, offset);
      const data2 = await getData(node2, contractName, t, offset);
      if (JSON.stringify(data1) !== JSON.stringify(data2)) {
        console.error(`Mismatch in ${contractName}:${t} at offset ${offset}`);
        console.error(JSON.stringify(data1));
        console.error(JSON.stringify(data2));
      } else {
        console.log(`compared ${contractName}:${t} at offset ${offset}`);
      }
      offset += 1000;
      if (data1.length < 1000) {
        done = true;
      }
    }
  }
}

contractNames.forEach(compare);
