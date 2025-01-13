/* generated file, don't edit. */


/**
 * Credentials ready to be used at runtime
 */
public struct UnencryptedCredentials : Codable {
	public init(
		credentialInfo: CredentialsInfo,
		accessToken: String,
		databaseKey: DataWrapper?,
		encryptedPassword: String,
		encryptedPassphraseKey: DataWrapper?,
		apiUrl: String
	) {
		self.credentialInfo = credentialInfo
		self.accessToken = accessToken
		self.databaseKey = databaseKey
		self.encryptedPassword = encryptedPassword
		self.encryptedPassphraseKey = encryptedPassphraseKey
		self.apiUrl = apiUrl
	}
	public let credentialInfo: CredentialsInfo
	public let accessToken: String
	public let databaseKey: DataWrapper?
	public let encryptedPassword: String
	public let encryptedPassphraseKey: DataWrapper?
	public let apiUrl: String
}
