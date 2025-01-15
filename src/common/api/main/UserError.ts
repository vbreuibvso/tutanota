import { lang, TranslationKey, TranslationText } from "../../misc/LanguageViewModel"
import { MaybeLazy, resolveMaybeLazy } from "@tutao/tutanota-utils"
import { assertMainOrNode } from "../common/Env"
import { TutanotaError } from "@tutao/tutanota-error"

assertMainOrNode()

export class UserError extends TutanotaError {
	constructor(message: MaybeLazy<TranslationText>) {
		super("UserError", lang.resolveToTranslation(resolveMaybeLazy(message)))
	}
}
