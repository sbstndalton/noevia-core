'use strict';
// Bounded fixture output, through Node's stream queue so partial/nonblocking
// pipe writes are retried rather than being mistaken for a verifier failure.
async function writeTail(output) {
  const write = (bytes) => new Promise((resolve, reject) => {
    output.write(bytes, (error) => error ? reject(error) : resolve());
  });
  await write(Buffer.alloc(2 * 1024 * 1024, 120));
  await write(Buffer.from('\u001b[31m\u0000END\n'));
}
module.exports = { writeTail };
