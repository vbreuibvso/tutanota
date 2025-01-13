/* generated file, don't edit. */

import { NativeMailImportFacade } from "./NativeMailImportFacade.js"

interface NativeInterface {
	invokeNative(requestType: string, args: unknown[]): Promise<any>
}
export class NativeMailImportFacadeSendDispatcher implements NativeMailImportFacade {
	constructor(private readonly transport: NativeInterface) {}
	async getResumeableImport(...args: Parameters<NativeMailImportFacade["getResumeableImport"]>) {
		return this.transport.invokeNative("ipc", ["NativeMailImportFacade", "getResumeableImport", ...args])
	}
	async prepareNewImport(...args: Parameters<NativeMailImportFacade["prepareNewImport"]>) {
		return this.transport.invokeNative("ipc", ["NativeMailImportFacade", "prepareNewImport", ...args])
	}
	async setProgressAction(...args: Parameters<NativeMailImportFacade["setProgressAction"]>) {
		return this.transport.invokeNative("ipc", ["NativeMailImportFacade", "setProgressAction", ...args])
	}
	async deinitLogger(...args: Parameters<NativeMailImportFacade["deinitLogger"]>) {
		return this.transport.invokeNative("ipc", ["NativeMailImportFacade", "deinitLogger", ...args])
	}
}
