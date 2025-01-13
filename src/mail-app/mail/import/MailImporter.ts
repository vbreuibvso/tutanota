import { getApiBaseUrl } from "../../../common/api/common/Env"
import { ImportMailState, ImportMailStateTypeRef, MailBox, MailFolder } from "../../../common/api/entities/tutanota/TypeRefs"
import { assertNotNull, first, isEmpty } from "@tutao/tutanota-utils"
import { NativeMailImportFacade } from "../../../common/native/common/generatedipc/NativeMailImportFacade"
import { CredentialsProvider } from "../../../common/misc/credentials/CredentialsProvider"
import { DomainConfigProvider } from "../../../common/api/common/DomainConfigProvider"
import { LoginController } from "../../../common/api/main/LoginController"
import m from "mithril"
import { elementIdPart, generatedIdToTimestamp, isSameId } from "../../../common/api/common/utils/EntityUtils.js"
import { MailboxModel } from "../../../common/mailFunctionality/MailboxModel.js"
import { MailModel } from "../model/MailModel.js"
import { EntityClient } from "../../../common/api/common/EntityClient.js"
import { LocalImportMailState } from "../../../common/native/common/generatedipc/LocalImportMailState.js"
import { ProgressMonitor } from "../../../common/api/common/utils/ProgressMonitor.js"
import { ProgrammingError } from "../../../common/api/common/error/ProgrammingError.js"
import Stream from "mithril/stream"
import { WsConnectionState } from "../../../common/api/main/WorkerClient.js"
import { EntityUpdateData, isUpdateForTypeRef } from "../../../common/api/common/utils/EntityUpdateUtils"
import { EventController } from "../../../common/api/main/EventController"

// keep in sync with napi binding.d.cts
export const enum ImportProgressAction {
	Continue = 0,
	Pause = 1,
	Stop = 2,
}

const DEFAULT_TOTAL_WORK: number = 100000
const DEFAULT_PROGRESS_ESTIMATION_MAILS_PER_SECOND = 5
const DEFAULT_PROGRESS_ESTIMATION_REFRESH_MS: number = 1000
const DEFAULT_PROGRESS: number = 0
const PROGRESS_ESTIMATION_MAILS_PER_SECOND_SCALING_RATIO = 0.75

export class MailImporter {
	public nativeMailImportFacade: NativeMailImportFacade | null = null
	public credentialsProvider: CredentialsProvider | null = null

	private domainConfigProvider: DomainConfigProvider
	private loginController: LoginController
	public mailboxModel: MailboxModel
	public mailModel: MailModel
	private entityClient: EntityClient

	private progressMonitor: ProgressMonitor | null = null
	private progressEstimation: TimeoutID
	private progress: number = DEFAULT_PROGRESS

	private finalisedImportStates: Map<Id, ImportMailState> = new Map()
	private activeImportState: IdTuple | null = null
	private uiStatus: UiImportStatus

	private eventController: EventController

	constructor(
		domainConfigProvider: DomainConfigProvider,
		loginController: LoginController,
		mailboxModel: MailboxModel,
		mailModel: MailModel,
		entityClient: EntityClient,
		eventController: EventController,
	) {
		this.domainConfigProvider = domainConfigProvider
		this.loginController = loginController
		this.mailboxModel = mailboxModel
		this.mailModel = mailModel
		this.entityClient = entityClient

		this.uiStatus = UiImportStatus.Idle
		this.updateProgressMonitorTotalWork(DEFAULT_TOTAL_WORK)
		this.eventController = eventController

		this.eventController.addEntityListener((updates) => this.entityEventsReceived(updates))
	}

	async getMailbox(): Promise<MailBox> {
		return assertNotNull(first(await this.mailboxModel.getMailboxDetails())).mailbox
	}

	async initImportMailStates(): Promise<void> {
		const importFacade = assertNotNull(this.nativeMailImportFacade)

		if (this.activeImportState === null) {
			const mailbox = await this.getMailbox()
			const mailOwnerGroup = (await this.mailboxModel.getUserMailboxDetails()).mailGroup
			const userId = this.loginController.getUserController().userId
			const unencryptedCredentials = assertNotNull(await this.credentialsProvider?.getDecryptedCredentialsByUserId(userId))
			this.activeImportState = await importFacade.getResumeableImport(mailbox._id, mailOwnerGroup._id, unencryptedCredentials)
		}

		if (this.activeImportState) {
			// we can't use the result of loadAll (see below) as that might only read from offline cache and
			// not include a new ImportMailState that was created without sending an entity event
			const importMailState = await this.entityClient.load(ImportMailStateTypeRef, this.activeImportState)
			const remoteStatus = parseInt(importMailState.status) as ImportStatus

			switch (remoteStatus) {
				case ImportStatus.Canceled | ImportStatus.Finished:
					throw new Error("import state on server is canceled but we still have id in filesystem. remove this state from file?")

				case ImportStatus.Paused | ImportStatus.Running:
					this.uiStatus = importStatusToUiImportStatus(remoteStatus)
					const doneCount = parseInt(importMailState.failedMails) + parseInt(importMailState.successfulMails)
					const totalCount = parseInt(importMailState.totalMails)
					this.updateProgressMonitorTotalWork(totalCount)
					this.progressMonitor?.totalWorkDone(doneCount)
			}
		}

		const importMailStatesCollection = await this.entityClient.loadAll(ImportMailStateTypeRef, (await this.getMailbox()).mailImportStates)
		for (const importMailState of importMailStatesCollection) {
			if (importMailState._id != this.activeImportState) {
				this.updateFinalisedImport(elementIdPart(importMailState._id), importMailState)
			}
		}
		m.redraw()
	}

	/**
	 * Call to the nativeMailImportFacade in worker to start a mail import from .eml or .mbox files.
	 * @param targetFolder in which to import mails into
	 * @param filePaths to the .eml/.mbox files to import mails from
	 */
	async onStartBtnClick(targetFolder: MailFolder, filePaths: Array<string>) {
		if (isEmpty(filePaths)) return
		if (!this.shouldShowStartButton()) throw new ProgrammingError("can't change state to starting")

		this.resetStatus()

		const apiUrl = getApiBaseUrl(this.domainConfigProvider.getCurrentDomainConfig())
		const ownerGroup = assertNotNull(targetFolder._ownerGroup)
		const userId = this.loginController.getUserController().userId
		const importFacade = assertNotNull(this.nativeMailImportFacade)
		const unencryptedCredentials = assertNotNull(await this.credentialsProvider?.getDecryptedCredentialsByUserId(userId))

		this.uiStatus = UiImportStatus.Starting
		this.startProgressEstimation()
		m.redraw()

		// todo:
		// call setProgressAction::Continue
	}

	async onPauseBtnClick() {
		if (this.uiStatus !== UiImportStatus.Running) {
			throw new ProgrammingError("can't change state to pausing")
		}

		this.uiStatus = UiImportStatus.Pausing
		this.stopProgressEstimation()
		m.redraw()

		await this.setProgressAction(ImportProgressAction.Pause)
	}

	async onResumeBtnClick() {
		if (!this.shouldShowResumeButton()) throw new ProgrammingError("can't change state to resuming")
		if (!this.activeImportState) throw new ProgrammingError("can't change state to resuming")

		this.uiStatus = UiImportStatus.Resuming
		this.startProgressEstimation()
		m.redraw()

		const importFacade = assertNotNull(this.nativeMailImportFacade)
		const apiUrl = getApiBaseUrl(this.domainConfigProvider.getCurrentDomainConfig())
		const userId = this.loginController.getUserController().userId

		const unencryptedCredentials = assertNotNull(await this.credentialsProvider?.getDecryptedCredentialsByUserId(userId))
		const resumableStateId = assertNotNull(this.activeImportState)

		try {
			// todo:
			// call setProgressAction::Continue
		} catch (e) {
			this.uiStatus = UiImportStatus.Error
			console.log("could not resume file import", e)
			m.redraw()
		}
	}

	async onCancelBtnClick() {
		if (!this.shouldShowCancelButton()) throw new ProgrammingError("can't change state to cancelling")

		this.uiStatus = UiImportStatus.Cancelling
		this.stopProgressEstimation()
		m.redraw()

		await this.setProgressAction(ImportProgressAction.Stop)
	}

	shouldShowStartButton() {
		return this.uiStatus === UiImportStatus.Idle || this.uiStatus === UiImportStatus.Error
	}

	shouldShowImportStatus(): boolean {
		return (
			this.uiStatus === UiImportStatus.Starting ||
			this.uiStatus === UiImportStatus.Running ||
			this.uiStatus === UiImportStatus.Pausing ||
			this.uiStatus === UiImportStatus.Paused ||
			this.uiStatus === UiImportStatus.Cancelling ||
			this.uiStatus === UiImportStatus.Resuming
		)
	}

	shouldShowPauseButton(): boolean {
		return this.uiStatus === UiImportStatus.Running || this.uiStatus === UiImportStatus.Starting || this.uiStatus === UiImportStatus.Pausing
	}

	shouldDisablePauseButton(): boolean {
		return this.uiStatus === UiImportStatus.Pausing || this.uiStatus === UiImportStatus.Starting
	}

	shouldShowResumeButton(): boolean {
		return this.uiStatus === UiImportStatus.Paused || this.uiStatus === UiImportStatus.Resuming
	}

	shouldDisableResumeButton(): boolean {
		return this.uiStatus === UiImportStatus.Resuming || this.uiStatus === UiImportStatus.Starting
	}

	shouldShowCancelButton(): boolean {
		return (
			this.uiStatus === UiImportStatus.Paused ||
			this.uiStatus === UiImportStatus.Running ||
			this.uiStatus === UiImportStatus.Pausing ||
			this.uiStatus === UiImportStatus.Cancelling
		)
	}

	shouldDisableCancelButton(): boolean {
		return this.uiStatus === UiImportStatus.Cancelling || this.uiStatus === UiImportStatus.Pausing || this.uiStatus === UiImportStatus.Starting
	}

	shouldShowProcessedMails(): boolean {
		return (
			this.uiStatus === UiImportStatus.Running ||
			this.uiStatus === UiImportStatus.Resuming ||
			this.uiStatus === UiImportStatus.Pausing ||
			this.uiStatus === UiImportStatus.Paused
		)
	}

	getTotalMailsCount() {
		if (this.progressMonitor) {
			return this.progressMonitor?.totalWork
		} else {
			return DEFAULT_TOTAL_WORK
		}
	}

	getProcessedMailsCount() {
		if (this.progressMonitor) {
			return Math.min(this.progressMonitor?.workCompleted, this.progressMonitor.totalWork)
		} else {
			return 0
		}
	}

	updateProgressMonitorTotalWork(newTotalWork: number) {
		this.progressMonitor = new ProgressMonitor(newTotalWork, (newProgressPercentage) => {
			this.progress = newProgressPercentage
			m.redraw()
		})
	}

	getFinalisedImports(): Array<ImportMailState> {
		return Array.from(this.finalisedImportStates.values())
	}

	updateFinalisedImport(importMailStateElementId: Id, importMailState: ImportMailState) {
		this.finalisedImportStates.set(importMailStateElementId, importMailState)
	}

	private startProgressEstimation() {
		clearInterval(this.progressEstimation)

		this.progressEstimation = setInterval(() => {
			let now = Date.now()
			let completedMails = this.progressMonitor?.workCompleted
			if (completedMails) {
				// todo
				// make it similar to: this.activeImport?.start_timestamp ?? now
				let startTimestamp = null ?? now
				let durationSinceStartSeconds = (now - startTimestamp) / 1000
				let mailsPerSecond = completedMails / durationSinceStartSeconds
				let mailsPerSecondEstimate = Math.max(1, mailsPerSecond * PROGRESS_ESTIMATION_MAILS_PER_SECOND_SCALING_RATIO)
				this.progressMonitor?.workDone(Math.round(mailsPerSecondEstimate))
			} else {
				this.progressMonitor?.workDone(DEFAULT_PROGRESS_ESTIMATION_MAILS_PER_SECOND)
			}
			m.redraw()
		}, DEFAULT_PROGRESS_ESTIMATION_REFRESH_MS)
	}

	private stopProgressEstimation() {
		clearInterval(this.progressEstimation)
	}

	async newImportStateFromServer(serverState: ImportMailState) {
		const wasUpdatedForThisImport = isSameId(this.activeImport?.remoteStateId ?? null, serverState._id)

		const remoteStatus = parseInt(serverState.status) as ImportStatus
		if (wasUpdatedForThisImport) {
			if (remoteStatus == ImportStatus.Paused) {
				this.activeImport = remoteStateAsLocal(serverState, this.activeImport)
				this.uiStatus = UiImportStatus.Paused
				m.redraw()
				return
			} else if (isFinalisedImport(remoteStatus)) {
				this.resetStatus()
			}
		}

		if (isFinalisedImport(remoteStatus)) {
			this.updateFinalisedImport(elementIdPart(serverState._id), serverState)
		}
		m.redraw()
	}

	private resetStatus() {
		this.activeImportState = null
		this.progressMonitor = null
		this.progress = 0
		this.stopProgressEstimation()
		this.uiStatus = UiImportStatus.Idle
	}

	async connectionStateListener(wsStream: Stream<WsConnectionState>) {
		wsStream.map(async (wsConnection) => {
			console.log("Importer says client connection is: " + wsConnection)

			// Importer will never it the loop if the client connection is offline,
			// as we don't have timeout on `dyn RestClient` yet.
			// this will put the ui to paused state immediately and
			// importer to paused state once client is back online ( after it can err/sucess current chunk )
			const haveImportOngoing = this.shouldShowImportStatus()
			this.wsConnectionOnline = wsConnection === WsConnectionState.connected
			if (haveImportOngoing && !this.wsConnectionOnline) {
				this.stopProgressEstimation()
				m.redraw()
			} else if (haveImportOngoing && this.wsConnectionOnline) {
				await this.setProgressAction(ImportProgressAction.Continue)
				this.uiStatus = UiImportStatus.Paused
			}
		})
	}

	getProgress() {
		return Math.round(this.progress)
	}

	getUiStatus() {
		if (this.uiStatus) {
			return this.uiStatus
		} else {
			return UiImportStatus.Idle
		}
	}

	async setProgressAction(progressAction: ImportProgressAction): Promise<void> {
		const importFacade = assertNotNull(this.nativeMailImportFacade)

		const apiUrl = getApiBaseUrl(this.domainConfigProvider.getCurrentDomainConfig())
		const userId = this.loginController.getUserController().userId
		const unencryptedCredentials = assertNotNull(await this.credentialsProvider?.getDecryptedCredentialsByUserId(userId))

		try {
			await importFacade.setProgressAction((await this.getMailbox())._id, apiUrl, unencryptedCredentials, progressAction)
		} catch (e) {
			console.log(`could execute progress action ${progressAction} for file import`, e)
		}
	}

	async entityEventsReceived(updates: ReadonlyArray<EntityUpdateData>): Promise<void> {
		for (const update of updates) {
			if (isUpdateForTypeRef(ImportMailStateTypeRef, update)) {
				const updatedState = await this.entityClient.load(ImportMailStateTypeRef, [update.instanceListId, update.instanceId])
				await this.newImportStateFromServer(updatedState)
			}
		}
	}
}

function remoteStateAsLocal(remoteState: ImportMailState, activeImport: LocalImportMailState | null = null): LocalImportMailState {
	return {
		failedMails: parseInt(remoteState.failedMails),
		remoteStateId: remoteState._id,
		start_timestamp: generatedIdToTimestamp(elementIdPart(remoteState._id)),
		status: parseInt(remoteState.status),
		successfulMails: parseInt(remoteState.successfulMails),
		totalMails: activeImport ? activeImport?.totalMails : DEFAULT_TOTAL_WORK,
	}
}

export const enum UiImportStatus {
	Idle,
	Starting,
	Resuming,
	Running,
	Pausing,
	Paused,
	Cancelling,
	Canceled,
	Error,
}

function importStatusToUiImportStatus(importStatus: ImportStatus) {
	switch (importStatus) {
		case ImportStatus.Finished:
			return UiImportStatus.Idle
		case ImportStatus.Canceled:
			return UiImportStatus.Idle
		case ImportStatus.Paused:
			return UiImportStatus.Paused
		case ImportStatus.Running:
			return UiImportStatus.Running
	}
}

export const enum ImportStatus {
	Running = 0,
	Paused = 1,
	Canceled = 2,
	Finished = 3,
}

export function isFinalisedImport(remoteImportStatus: ImportStatus): boolean {
	return remoteImportStatus == ImportStatus.Canceled || remoteImportStatus == ImportStatus.Finished
}
