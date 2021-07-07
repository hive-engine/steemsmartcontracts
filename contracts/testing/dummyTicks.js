/* eslint-disable no-await-in-loop */
/* eslint-disable quote-props */
/* eslint-disable max-len */
/* global actions, api */

actions.createSSC = () => {
  // Initialize the smart contract via the create action
};
actions.checkPendingUnstakes = () => {
  api.emit('checkPendingUnstakes', {});
};
actions.checkPendingUndelegations = () => {
  api.emit('checkPendingUndelegations', {});
};
actions.tick = () => {
  api.emit('tick', {});
};
actions.checkPendingLotteries = () => {
  api.emit('checkPendingLotteries', {});
};
actions.checkPendingAirdrops = () => {
  api.emit('checkPendingAirdrops', {});
};
actions.updateAuctions = () => {
  api.emit('updateAuctions', {});
};
actions.scheduleWitnesses = () => {
  api.emit('scheduleWitnesses', {});
};
actions.checkPendingDtfs = () => {
  api.emit('checkPendingDtfs', {});
};
