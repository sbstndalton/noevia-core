const test = require('node:test');
const assert = require('node:assert/strict');
const { startDiaryBackupWorker } = require('../../server/diary-backup-worker.cjs');
test('backup worker resumes eligible tenants, isolates failures and stops', async () => {
  const calls = [], errors = [];
  let stop;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('worker did not run')), 1000);
    stop = startDiaryBackupWorker({
      interval: 5,
      users: () => [{id:'enabled'}, {id:'disabled'}, {id:'offline'}],
      enabled: id => id !== 'disabled',
      run: async user => { calls.push(user.id); if(user.id === 'offline') throw Error('private error'); },
      onError: id => { errors.push(id); stop(); clearTimeout(timeout); resolve(); },
    });
  });
  assert.deepEqual(calls.sort(), ['enabled', 'offline']);
  assert.deepEqual(errors, ['offline']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
});
