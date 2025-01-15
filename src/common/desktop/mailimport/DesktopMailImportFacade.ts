import { AsyncMailImportError, ImporterApi, PreparationError, TutaCredentials } from "../../../../packages/node-mimimi/dist/binding.cjs"
import { UnencryptedCredentials } from "../../native/common/generatedipc/UnencryptedCredentials.js"
import { CredentialType } from "../../misc/credentials/CredentialType.js"
import { NativeMailImportFacade } from "../../native/common/generatedipc/NativeMailImportFacade"
import { defer, DeferredObject } from "@tutao/tutanota-utils"
import { ElectronExports } from "../ElectronExportTypes.js"
import { MailImportError } from "../../api/common/error/MailImportError.js"
import { ProgrammingError } from "../../api/common/error/ProgrammingError.js"

type Listener = DeferredObject<AsyncMailImportError>["reject"]

export type ImportErrorData =
	| { category: "LocalSdkError"; source: string }
	| { category: "ServerCommunicationError"; source: string }
	| { category: "InvalidImportFilesErrors"; source: string }
	| { category: "InvalidEml"; source: string }
	| { category: "" }

function asyncImportErrorToMailImportError(error: AsyncMailImportError): ImportErrorData {
	throw new ProgrammingError("not implemented yet!")
}

function mimimiErrorToImportErrorData(error: { message: string }): ImportErrorData {
	const { message: source } = error
	switch (source) {
		// errors related to the files we use to track the import progress.
		// might require manual intervention due to misconfiguration or leftover files.
		case PreparationError.NoStateFile:
		case PreparationError.MalformedStateFile:
		case PreparationError.ImportDirectoryPreparation:
		case PreparationError.FailedToReadEmls:
		case PreparationError.StateFileWriteFailed:
		case PreparationError.CanNotCreateImportDir:
		case PreparationError.CanNotDeleteImportDir:
		case PreparationError.FileReadError:
		case PreparationError.EmlFileWriteFailure:
			return { category: "InvalidImportFilesErrors", source }
		// errors due to problems communicating with the server (network, auth,...)
		case PreparationError.CanNotLoginToSdk:
		case PreparationError.LoginError:
		case PreparationError.NoMailGroupKey:
		case PreparationError.CannotLoadRemoteState:
		case PreparationError.NoImportFeature:
			return { category: "ServerCommunicationError", source }
		// errors that happen before we even talk to the server. usually not actionable.
		case PreparationError.CannotCreateSdk:
		case PreparationError.NoNativeRestClient:
			return { category: "LocalSdkError", source }
		// this one is very actionable, but we don't have associated data currently to show the user which file is bad.
		case PreparationError.NotAValidEmailFile:
			return { category: "InvalidEml", source }
		default:
			// we'd like ts to check we considered all variants, but we can't do that without checking the type
			// before passing it into this function. removing the default case would cause us to lose error
			// types we didn't account for.
			throw new ProgrammingError(`unknown mimimi error ${error}`)
	}
}

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
			let importerApi
			try {
				importerApi = await ImporterApi.getResumableImport(mailboxId, this.configDirectory, targetOwnerGroup, tutaCredentials)
			} catch (e) {
				throw new MailImportError(mimimiErrorToImportErrorData(e))
			}
			if (importerApi != null) {
				importerApi.setErrorHook((err: AsyncMailImportError) => this.processMimimiMessage(mailboxId, err))
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

		let importerApi
		try {
			importerApi = await ImporterApi.prepareNewImport(
				mailboxId,
				tutaCredentials,
				targetOwnerGroup,
				[targetMailset[0], targetMailset[1]],
				filePaths.slice(),
				this.configDirectory,
			)
		} catch (e) {
			throw new MailImportError(mimimiErrorToImportErrorData(e.message))
		}
		importerApi.setErrorHook((err: AsyncMailImportError) => this.processMimimiMessage(mailboxId, err))
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

	async setAsyncErrorHook(mailboxId: string): Promise<void> {
		const { promise, reject } = defer<void>()
		const listeners = this.currentListeners.get(mailboxId)
		if (listeners != null) {
			listeners.push(reject)
		} else {
			const newListeners = [reject]
			this.currentListeners.set(mailboxId, newListeners)
		}
		return promise
	}

	private processMimimiMessage(mailboxId: string, error: AsyncMailImportError) {
		let listeners = this.currentListeners.get(mailboxId)
		if (listeners != null) {
			for (const listener of listeners) {
				const mailImportError = new MailImportError(asyncImportErrorToMailImportError(error))
				listener(mailImportError)
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
