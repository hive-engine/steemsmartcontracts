actions.createSSC = function (payload) {
  // Initialize the smart contract via the create action
}
actions.checkPendingUnstakes = () => {
    api.emit('checkPendingUnstakes', {});
}
actions.checkPendingUndelegations = () => {
    api.emit('checkPendingUndelegations', {});
}
actions.tick = () => {
    api.emit('tick', {});
}
actions.checkPendingLotteries = () => {
    api.emit('checkPendingLotteries', {});
}
actions.checkPendingAirdrops = () => {
    api.emit('checkPendingAirdrops', {});
}
actions.updateAuctions = () => {
    api.emit('updateAuctions', {});
}
actions.scheduleWitnesses = () => {
    api.emit('scheduleWitnesses', {});
}
actions.checkPendingDtfs = () => {
    api.emit('checkPendingDtfs', {});
}
