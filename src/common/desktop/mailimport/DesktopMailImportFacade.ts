import { ImportStatus, ImporterApi, TutaCredentials } from "../../../../packages/node-mimimi/dist/binding.cjs"
import { UnencryptedCredentials } from "../../native/common/generatedipc/UnencryptedCredentials.js"
import { CredentialType } from "../../misc/credentials/CredentialType.js"
import { NativeMailImportFacade } from "../../native/common/generatedipc/NativeMailImportFacade"
import { defer, DeferredObject } from "@tutao/tutanota-utils"
import { ElectronExports } from "../ElectronExportTypes.js"

type Listener = DeferredObject<string>["resolve"]

export class DesktopMailImportFacade implements NativeMailImportFacade {
	private configDirectory: string
	private readonly importerApis: Map<string, ImporterApi> = new Map()
	private readonly currentListeners: Map<string, Array<Listener>> = new Map()

	constructor(electron: ElectronExports) {
		ImporterApi.initLog()
		electron.app.on("before-quit", () => ImporterApi.deinitLog())
		this.configDirectory = electron.app.getPath("userData")
	}

	async getResumableImport(
		mailboxId: string,
		targetOwnerGroup: string,
		unencryptedTutaCredentials: UnencryptedCredentials,
		apiUrl: string,
	): Promise<readonly [string, string] | null> {
		const existingImporterApi = this.importerApis.get(mailboxId)
		if (existingImporterApi) {
			const { listId, elementId } = existingImporterApi.getImportStateId()
			return [listId, elementId]
		} else {
			const tutaCredentials = this.createTutaCredentials(unencryptedTutaCredentials, apiUrl)
			const importerApi = await ImporterApi.getResumableImport(mailboxId, this.configDirectory, targetOwnerGroup, tutaCredentials)
			if (importerApi != null) {
				importerApi.setErrorHook((err: string) => this.processMimimiMessage(mailboxId, err))
				console.log("set a hook")
				this.importerApis.set(mailboxId, importerApi)
				const { listId, elementId } = importerApi.getImportStateId()
				return [listId, elementId]
			}
		}

		return null
	}

	async prepareNewImport(
		mailboxId: string,
		targetOwnerGroup: string,
		targetMailset: readonly string[],
		filePaths: readonly string[],
		unencryptedTutaCredentials: UnencryptedCredentials,
		apiUrl: string,
	): Promise<readonly [string, string]> {
		const tutaCredentials = this.createTutaCredentials(unencryptedTutaCredentials, apiUrl)

		if (this.importerApis.has(mailboxId)) {
			const importerApi = await ImporterApi.getResumableImport(mailboxId, this.configDirectory, targetOwnerGroup, tutaCredentials)
			if (importerApi) {
				const importStatus = await importerApi.getImportStatus()
				if (importStatus != null && (importStatus == ImportStatus.Finished || importStatus == ImportStatus.Canceled)) {
					this.markFinalImportState(mailboxId)
				} else {
					throw new Error("an import is already running for this mailbox")
				}
			}
		}

		const importerApi = await ImporterApi.prepareNewImport(
			mailboxId,
			tutaCredentials,
			targetOwnerGroup,
			[targetMailset[0], targetMailset[1]],
			filePaths.slice(),
			this.configDirectory,
		)
		importerApi.setErrorHook((err: string) => this.processMimimiMessage(mailboxId, err))
		this.importerApis.set(mailboxId, importerApi)
		const { listId, elementId } = importerApi.getImportStateId()

		return [listId, elementId]
	}

	async setProgressAction(mailboxId: string, progressAction: number): Promise<void> {
		let importerApi = this.importerApis.get(mailboxId)
		if (!importerApi) {
			throw new Error("no import for this mailbox id running")
		}
		await importerApi.setProgressAction(progressAction)
	}

	async getNextLocalEvent(mailboxId: string): Promise<string> {
		console.log("setting up a callback")
		const { promise, resolve } = defer<string>()
		const listeners = this.currentListeners.get(mailboxId)
		if (listeners != null) {
			listeners.push(resolve)
		} else {
			const newListeners = [resolve]
			this.currentListeners.set(mailboxId, newListeners)
		}
		return promise
	}

	private processMimimiMessage(mailboxId: string, error: string) {
		console.log("calling a hook")
		let listeners = this.currentListeners.get(mailboxId)
		if (listeners != null) {
			for (const listener of listeners) {
				listener(error)
			}
		}
	}

	private createTutaCredentials(unencTutaCredentials: UnencryptedCredentials, apiUrl: string) {
		const tutaCredentials: TutaCredentials = {
			accessToken: unencTutaCredentials?.accessToken,
			isInternalCredential: unencTutaCredentials.credentialInfo.type === CredentialType.Internal,
			encryptedPassphraseKey: unencTutaCredentials.encryptedPassphraseKey ? Array.from(unencTutaCredentials.encryptedPassphraseKey) : [],
			login: unencTutaCredentials.credentialInfo.login,
			userId: unencTutaCredentials.credentialInfo.userId,
			apiUrl,
			clientVersion: env.versionNumber,
		}
		return tutaCredentials
	}

	private markFinalImportState(mailboxId: string) {
		this.importerApis.delete(mailboxId)
	}
}
