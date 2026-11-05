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
  return createMcpWiring({ ...wiringArgs, discovery: reference });
}

module.exports = { ...rest, createMcpWiring: createMcpWiringWithReference, bindBoxes };
