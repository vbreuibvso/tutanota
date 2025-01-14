import { OfflineMigration } from "../OfflineStorageMigrator.js"
import { OfflineStorage } from "../OfflineStorage.js"

export const tutanota80: OfflineMigration = {
	app: "tutanota",
	version: 80,
	async migrate(storage: OfflineStorage) {
		// only service changes, no persisted types
	},
}
