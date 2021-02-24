/* eslint-disable */
const { fork } = require("child_process");
const assert = require("assert");
const { MongoClient } = require("mongodb");
const { CONSTANTS } = require("../libs/Constants");
const { Database } = require("../libs/Database");
const blockchain = require("../plugins/Blockchain");
const { Transaction } = require("../libs/Transaction");
const { setupContractPayload } = require("../libs/util/contractUtil");

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.hive.blog"],
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null;

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: "request",
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}

// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === "MASTER") {
      if (type && type === "request") {
        // do something
      } else if (type && type === "response" && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === "broadcast") {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error("ROUTING ERROR: ", message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on("message", (msg) => route(msg));
  plugin.cp.stdout.on("data", (data) =>
    console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString())
  );
  plugin.cp.stderr.on("data", (data) =>
    console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString())
  );

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, "MASTER", {
    action: "init",
    payload: conf,
  });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill("SIGINT");
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
};

const tokensContractPayload = setupContractPayload(
  "tokens",
  "./contracts/tokens.js"
);
const contractPayload = setupContractPayload(
  "hodl",
  "./contracts/hodl.js"
);

function assertError(tx, message) {
  const logs = JSON.parse(tx.logs);
  assert(logs.errors, 'No error in logs. Error expected with message ' + message);
  assert.equal(logs.errors[0], message, `Error expected with message ${message}. Instead got ${logs.errors[0]}`);
}

async function assertNoErrorInLastBlock() {
  const transactions = (await database1.getLatestBlockInfo()).transactions;
  for (let i = 0; i < transactions.length; i++) {
    const logs = JSON.parse(transactions[i].logs);
    assert(!logs.errors, `Tx #${i} had unexpected error ${logs.errors}`);
  }
}

let txId = 1;
function getNextTxId() {
  txId++;
  return `TXID${txId.toString().padStart(8, "0")}`;
}

describe("hodl tests", function () {
  // go back to this.timeout(30000) later
  this.timeout(30000000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, {
        useNewUrlParser: true,
      });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    }).then(() => {
      done();
    });
  });

  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    }).then(() => {
      done();
    });
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    }).then(() => {
      done();
    });
  });

  afterEach((done) => {
    new Promise(async (resolve) => {
      await db.dropDatabase();
      resolve();
    }).then(() => {
      done();
    });
  });
});
