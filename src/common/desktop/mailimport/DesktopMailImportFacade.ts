import { ImporterApi, TutaCredentials } from "../../../../packages/node-mimimi/dist/binding.cjs"
import { UnencryptedCredentials } from "../../native/common/generatedipc/UnencryptedCredentials.js"
import { CredentialType } from "../../misc/credentials/CredentialType.js"
import { NativeMailImportFacade } from "../../native/common/generatedipc/NativeMailImportFacade"

export class DesktopMailImportFacade implements NativeMailImportFacade {
	private configDirectory: string
	private readonly importerApis: Map<string, ImporterApi> = new Map()

	constructor(configDirectory: string) {
		ImporterApi.initLog()
		this.configDirectory = configDirectory
	}

	async getResumeableImport(
		mailboxId: string,
		targetOwnerGroup: string,
		unencryptedTutaCredentials: UnencryptedCredentials,
	): Promise<readonly [string, string] | null> {
		const tutaCredentials = this.createTutaCredentials(unencryptedTutaCredentials)
		const importerApi = await ImporterApi.getResumableImport(mailboxId, this.configDirectory, targetOwnerGroup, tutaCredentials)

		if (importerApi != null) {
			this.importerApis.set(mailboxId, importerApi)
			const { listId, elementId } = importerApi.getImportStateId()
			return [listId, elementId]
		} else {
			this.importerApis.delete(mailboxId)
			return null
		}
	}

	async prepareNewImport(
		mailboxId: string,
		unencryptedTutaCredentials: UnencryptedCredentials,
		targetOwnerGroup: string,
		targetMailset: readonly string[],
		filePaths: readonly string[],
	): Promise<readonly [string, string]> {
		const tutaCredentials = this.createTutaCredentials(unencryptedTutaCredentials)
		if (this.importerApis.has(mailboxId)) {
			// todo: error type?
			throw new Error("already have a running import for this mailbox")
		} else {
			const importerApi = await ImporterApi.prepareNewImport(
				mailboxId,
				tutaCredentials,
				targetOwnerGroup,
				[targetMailset[0], targetMailset[1]],
				filePaths.slice(),
				this.configDirectory,
			)
			this.importerApis.set(mailboxId, importerApi)
			const { listId, elementId } = importerApi.getImportStateId()
			return [listId, elementId]
		}
	}

	async setProgressAction(mailboxId: string, progressAction: number): Promise<void> {
		let importerApi = this.importerApis.get(mailboxId)
		if (!importerApi) {
			throw new Error("no import for this mailbox id running")
		}
		await importerApi.setProgressAction(progressAction)
	}

	async deinitLogger() {
		ImporterApi.deinitLog()
	}

	private createTutaCredentials(unencTutaCredentials: UnencryptedCredentials) {
		const tutaCredentials: TutaCredentials = {
			accessToken: unencTutaCredentials?.accessToken,
			isInternalCredential: unencTutaCredentials.credentialInfo.type === CredentialType.Internal,
			encryptedPassphraseKey: unencTutaCredentials.encryptedPassphraseKey ? Array.from(unencTutaCredentials.encryptedPassphraseKey) : [],
			login: unencTutaCredentials.credentialInfo.login,
			userId: unencTutaCredentials.credentialInfo.userId,
			apiUrl: unencTutaCredentials.apiUrl,
			clientVersion: env.versionNumber,
		}
		return tutaCredentials
	}

	/// once importState is in final status: Cancel, Finish remove it from map
	// todo: where to call this from?
	private markFinalImportState(mailboxId: string) {
		this.importerApis.delete(mailboxId)
	}
}
