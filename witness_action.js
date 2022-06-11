require('dotenv').config();
const dhive = require('@hiveio/dhive');
const program = require('commander');
const packagejson = require('./package.json');
const config = require('./config.json');

const ip = process.env.NODE_IP;
const witnessAccount = process.env.ACCOUNT;
const privateSigningKey = dhive.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY);
const publicSigningKey = privateSigningKey.createPublic().toString();
const {
  rpcNodePort, p2pPort, streamNodes, chainId,
} = config;

// For external NATed-ports customization
const extRPCNodePort = Number(String(process.env.RPCNODEPORT)) || rpcNodePort;
const extP2PPort = Number(String(process.env.P2PPORT)) || p2pPort;

function broadcastWitnessAction(contractAction, contractPayload) {
  const client = new dhive.Client(streamNodes[0]);
  const transaction = {
    required_auths: [witnessAccount],
    required_posting_auths: [],
    id: `ssc-${chainId}`,
    json: JSON.stringify({
      contractName: 'witnesses',
      contractAction,
      contractPayload,
    }),
  };

  client.broadcast.json(transaction, privateSigningKey).then((res) => {
    // eslint-disable-next-line no-console
    console.log(`Successful, trx id: ${res.id}`);
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Error', err);
  });
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
    RPCPort: extRPCNodePort,
    P2PPort: extP2PPort,
    signingKey: publicSigningKey,
    enabled: true,
  }));

program
  .command('unregister')
  .action(() => broadcastWitnessAction('register', {
    IP: ip,
    RPCPort: extRPCNodePort,
    P2PPort: extP2PPort,
    signingKey: publicSigningKey,
    enabled: false,
  }));

program.parse(process.argv);
