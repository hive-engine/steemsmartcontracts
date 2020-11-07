# Enhanced JSON Smart Contracts for HIVE - he.hive-roller.com 
(forked from hive-engine.com/steemsmartcontract) 

<!--[![Build Status](https://travis-ci.org/harpagon210/steemsmartcontracts.svg?branch=master)](https://travis-ci.org/harpagon210/steemsmartcontracts)[![Coverage Status](https://coveralls.io/repos/github/harpagon210/steemsmartcontracts/badge.svg?branch=master)](https://coveralls.io/github/harpagon210/steemsmartcontracts?branch=master)-->

 ## 1.  What is it?

Enhanced JSON Smart Contracts is a 2nd level HIVE sidechain utilizing JSON wrapped NodeJS encoded with base64 and hashed which runs alongside the HIVE blockcchain, it allows you to perform actions on a decentralized database via the power of "Smart Contracts" (Smart Contracts in this case meaning obfuscated NodeJS scripts shoved into custom_JSON operations on the HIVE Blockchain) ultimately leading to a bunch of code getting shoved into a (possibly) decentralized database to be used by folks worldwide.

 ## 2.  How does it work?

This system operates concurrently beside the HIVE blockchain by allowing users to trigger NodeJS scripts built in to blocks within the sidechain and primarily uses the customJSON or transfer operations built in to the HIVE blockchain in order to operate or trigger code.

 ## 3.  Sidechain specifications
- run on [node.js](https://nodejs.org) v13.7+
- database layer powered by [MongoDB](https://www.mongodb.com/)
- Smart Contracts coded in Javascript and obfuscated with Base64. Then the values of the info are hashed.
- Smart Contracts run in a sandboxed Javascript Virtual Machine called [VM2](https://github.com/patriksimek/vm2)
- a block on the sidechain is produced only if transactions are being parsed in a Hive block.

## 4. Setup a Hive Smart Contracts node

If you want to set up a Node check out @inertia's tender or meseeker programs:
meseeker: https://github.com/inertia186/meeseeker
tender: https://github.com/inertia186/tender

See the original instruction here: https://github.com/harpagon210/steemsmartcontracts/wiki/How-to-setup-a-Steem-Smart-Contracts-node
(While a good place to start doesn't begin to explain how to get your own node going or how to generate contracts yourself)

## 5. Tests
* npm run test

## 6. Usage/docs

* see wiki: https://github.com/harpagon210/steemsmartcontracts/wiki
