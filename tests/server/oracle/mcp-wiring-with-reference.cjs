'use strict';
// createMcpWiring (server/mcp-wiring.cjs) with the JS reference of discovery (./mcp-discovery.cjs) standing in for the
// Rust front, for the tests that exercise the EXECUTOR against fake MCP servers. Takes the arguments the wiring took
// before discovery moved (manifest, bindBoxes, isUserDisabled, discovery timings) and hands them to the reference.
const { createMcpWiring, ...rest } = require('../../../server/mcp-wiring.cjs');
const { createReferenceDiscovery } = require('./mcp-discovery.cjs');
const { bindBoxes } = require('./mcp-boxes.cjs');

function createMcpWiringWithReference(args) {
  const { manifest, bindBoxes: customBind, isUserDisabled, discoveryTtlMs, discoveryFailTtlMs, discoveryRetryMs, discovery, ...wiringArgs } = args;
  const reference = discovery || createReferenceDiscovery({
    servers: args.servers, manifest, ...(customBind ? { bindBoxes: customBind } : {}), mcp: args.mcp, directoryMcp: args.directoryMcp, mcpOAuth: args.mcpOAuth, mcpKeys: args.mcpKeys,
    directoryUrlAllowed: args.directoryUrlAllowed, publicFetch: args.publicFetch, internal: args.internal, internalKey: args.internalKey,
    env: args.env, logger: args.logger,
    ...(isUserDisabled ? { isUserDisabled } : {}),
    ...(discoveryTtlMs !== undefined ? { discoveryTtlMs } : {}),
    ...(discoveryFailTtlMs !== undefined ? { discoveryFailTtlMs } : {}),
    ...(discoveryRetryMs !== undefined ? { discoveryRetryMs } : {}),
  });
  const wiring = createMcpWiring({ ...wiringArgs, discovery: reference });
  // Tests that exercise one server's discovery (DNS rebinding, hostile schemas) reach the reference's.
  return reference.discoverOneServer ? { ...wiring, discoverOneServer: reference.discoverOneServer } : wiring;
}

module.exports = { ...rest, createMcpWiring: createMcpWiringWithReference, bindBoxes };
