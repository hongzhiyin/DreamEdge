export class ToolContractError extends Error {
  constructor(
    readonly code: 'INVALID_TOOL_DEFINITION' | 'INVALID_TOOL_ARGUMENTS' | 'UNKNOWN_TOOL'
      | 'DUPLICATE_TOOL' | 'UNSUPPORTED_TOOLS' | 'INVALID_TOOL_STATE' | 'INVALID_TRANSCRIPT' | 'INVALID_JSON',
    message: string,
  ) { super(message); this.name = 'ToolContractError'; }
}
