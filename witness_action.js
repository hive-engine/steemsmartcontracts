require('dotenv').config();
const dhive = require('@hiveio/dhive');
const program = require('commander');
const packagejson = require('./package.json');
const config = require('./config.json');

const ip = process.env.NODE_IP;
const witnessAccount = process.env.ACCOUNT;
const privateSigningKey = dhive.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY);
const publicSigningKey = privateSigningKey.createPublic().toString();
const rpcPort = config.rpcNodePort;
const p2pPort = config.p2pPort;

function broadcastWitnessAction(contractAction, contractPayload) {
  const client = new dhive.Client('https://api.hive.blog');
  const transaction = {
    required_auths: [witnessAccount],
    required_posting_auths: [],
    id: 'ssc-mainnet-hive',
    json: JSON.stringify({
      contractName: 'witnesses',
      contractAction,
      contractPayload,
    }),
  };

  // eslint-disable-next-line no-console
  client.broadcast.json(transaction, privateSigningKey, (x, y) => console.log(x || y));
}

program.version(packagejson.version);
program
  .command('approve <witness>')
  .action(witness => broadcastWitnessAction('approve', { witness }));
program
  .command('disapprove <witness>')
  .action(witness => broadcastWitnessAction('disapprove', { witness }));

program
  .command('register')
  .action(() => broadcastWitnessAction('register', {
    IP: ip,
    RPCPort: rpcPort,
    P2PPort: p2pPort,
    signingKey: publicSigningKey,
    enabled: true,
  }));

program
  .command('unregister')
  .action(() => broadcastWitnessAction('register', {
    IP: ip,
    RPCPort: rpcPort,
    P2PPort: p2pPort,
    signingKey: publicSigningKey,
    enabled: false,
  }));

program.parse(process.argv);
