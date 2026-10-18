import { operationNames, operationVersion } from './operation-types.js';
export const isAccountMutation = (version: string) => ['pi-1.1.0/account-mutation-1', operationVersion].includes(version);
export const isMutation = (version: string) => isAccountMutation(version) || version === 'pi-1.1.0/scoped-mutation-1';
export const isFileTool = (version: string) => isMutation(version) || version === 'pi-1.1.0/scoped-read-1';
export const isMutationName = (name: string) => ['write', 'edit', ...operationNames].includes(name);
