/* generated file, don't edit. */

import { UnencryptedCredentials } from "./UnencryptedCredentials.js"
import { NativeMailImportFacade } from "./NativeMailImportFacade.js"

export class NativeMailImportFacadeReceiveDispatcher {
	constructor(private readonly facade: NativeMailImportFacade) {}
	async dispatch(method: string, arg: Array<any>): Promise<any> {
		switch (method) {
			case "getResumeableImport": {
				const mailboxId: string = arg[0]
				const targetOwnerGroup: string = arg[1]
				const unencryptedTutaCredentials: UnencryptedCredentials = arg[2]
				return this.facade.getResumeableImport(mailboxId, targetOwnerGroup, unencryptedTutaCredentials)
			}
			case "prepareNewImport": {
				const mailboxId: string = arg[0]
				const unencryptedTutaCredentials: UnencryptedCredentials = arg[1]
				const targetOwnerGroup: string = arg[2]
				const targetMailset: ReadonlyArray<string> = arg[3]
				const filePaths: ReadonlyArray<string> = arg[4]
				return this.facade.prepareNewImport(mailboxId, unencryptedTutaCredentials, targetOwnerGroup, targetMailset, filePaths)
			}
			case "setProgressAction": {
				const mailboxId: string = arg[0]
				const importProgressAction: number = arg[1]
				return this.facade.setProgressAction(mailboxId, importProgressAction)
			}
			case "deinitLogger": {
				return this.facade.deinitLogger()
			}
		}
	}
}
