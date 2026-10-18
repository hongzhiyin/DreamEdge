import type { ChatBridge } from '../src/chat/types.js';
import type { McpControlBridge } from '../src/mcp/control-types.js';
declare global { interface Window {
    dreamedgeEmbedded?: boolean; dreamedge: ChatBridge; dreamedgeMcp?: McpControlBridge } }
