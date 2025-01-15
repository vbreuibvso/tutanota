//@bundleInto:common-min

import { TutanotaError } from "@tutao/tutanota-error"
import type { ImportErrorData } from "../../../desktop/mailimport/DesktopMailImportFacade.js"

export class MailImportError extends TutanotaError {
	data: ImportErrorData

	constructor(data: ImportErrorData) {
		super("MailImportError", `Failed to import mails`)
		this.data = data
	}
}
