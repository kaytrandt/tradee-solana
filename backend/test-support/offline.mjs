// This judge test process cannot connect to a provider, RPC, or database server.
// Test doubles remain usable; generated signing keys are ephemeral test data.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { throw new Error('Network access is disabled in the public judge test suite. Inject a test transport.'); };
net.Socket.prototype.connect = blocked;
globalThis.fetch = async () => blocked();
syncBuiltinESMExports();
