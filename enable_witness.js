require('dotenv').config();
const dhive = require('@hiveio/dhive');

const ip = process.env.NODE_IP;
const client = new dhive.Client("https://api.hive.blog");
const witnessAccount = process.env.ACCOUNT;
const privateSigningKey = dhive.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY);
const publicSigningKey = privateSigningKey.createPublic().toString();
const transaction = {
    required_auths: [witnessAccount],
    required_posting_auths: [],
    id: "ssc-mainnet-hive",
    json: JSON.stringify({
            "contractName": "witnesses",
            "contractAction": "register",
            "contractPayload": {
                            "IP": ip,
                            "RPCPort": 5000,
                            "P2PPort": 5001,
                            "signingKey": publicSigningKey,
                            "enabled": true
                        }
        }),
};

client.broadcast.json(transaction, privateSigningKey, x => console.log(x));
