'use strict';
// Native owner client; remote chat arrival interrupts the native measurement before the turn.
const { call, callAsync } = require('./native-machines-client.cjs');
const STORE_KEY = 'inference:machineTune';
const CHAT_SERVICES = Object.freeze({ chatFast: 'fast', chatSmart: 'smart', chatCode: 'code', chatCreative: 'creative', vision: 'vision' });
function createMachineTune() {
 return {
  start: ({service, confirm, actor}) => callAsync({op:'tune',service,confirm,actor}),
  abort: actor => call({op:'tuneAbort',actor}),
  status: () => call({op:'tuneStatus'}),
  resultFor: (machineId,model) => call({op:'tuneResult',machineId,model}),
 };
}
module.exports = { createMachineTune, STORE_KEY, CHAT_SERVICES };
