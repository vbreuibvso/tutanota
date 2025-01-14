use crate::importer::importable_mail::MailParseError;
use std::path::PathBuf;
use tutasdk::ApiCallError;

/// Error that can happen when we are inside the importer loop
#[derive(Debug)]
pub enum ImportError {
	SdkError {
		// action we were trying to perform on sdk
		action: &'static str,
		// actual error sdk returned
		error: ApiCallError,
	},
	/// import feature is not available for this user
	NoImportFeature,
	/// Blob responded with empty server url list
	EmptyBlobServerList,
	/// the element ID of the current import state directory is missing or not a valid ID
	LocalImportStateIdInvalid,
	/// Error while iterating through import source
	IterationError(IterationError),
	/// Some mail was too big
	TooBigChunk,
	/// Error that occured when deleting a file
	FileDeletionError(std::io::Error, PathBuf),
	/// Generic counterpart for SdkError
	// note: do not throw this manually
	GenericSdkError,
}

/// Errors that can happen when we are preparing for an import.
/// i.e before we enter importer loop
#[napi_derive::napi]
#[repr(u8)]
#[cfg_attr(test, derive(Debug))]
pub enum PreparationError {
	/// import state file does not exist at all
	NoStateFile = 0,
	/// import state file exists, but it's content can not be deserialized to valid idTuple
	MalformedStateFile = 1,
	/// Can not create a native Rest client
	NoNativeRestClient = 2,
	/// Can not log in through sdk
	CanNotLoginToSdk = 3,
	/// Can not create a sdk
	CannotCreateSdk = 4,
	/// some error occurred while preparing import directory
	ImportDirectoryPreparation = 5,
	/// Can not create valid credential from given raw input
	CredentialValidationError = 6,
	/// Error when trying to resume the session passed from client
	LoginError = 7,
	/// Can not read all the eml files in import directory
	FailedToReadEmls = 8,
	/// can not get mail group key from sdk
	NoMailGroupKey = 9,
	/// can not load remote state
	CannotLoadRemoteState = 10,
	/// No import feature
	NoImportFeature = 11,
	/// Can not write to state file
	StateFileWriteFailed = 12,
	/// Can not create directory to keep selected files
	CanNotCreateImportDir = 13,
	/// Can not delete import directory
	CanNotDeleteImportDir = 14,
	/// Can not read one of selected file
	FileReadError = 15,
	/// Can not parse file content to Message format
	NotAValidEmailFile = 16,
	/// Can not write eml file to import dir
	EmlFileWriteFailure = 17,
	/// Not a valid eml or mbox file
	UnsupportedFile = 18,
}

/// Unification of Imap & File IterationError
#[derive(Debug)]
pub enum IterationError {
	Imap(ImapIterationError),
	File(FileIterationError),
}

/// Error that can occur when we walk through the source of imap mails
#[derive(Debug, PartialEq, Clone)]
pub enum ImapIterationError {
	/// All mail form remote server have been visited at least once,
	SourceEnd,

	/// when executing a command, received a non-ok status,
	NonOkCommandStatus,

	/// Can not convert ImapMail to ConvertableMail
	MailParseError(MailParseError),

	/// Can not log in to imap server
	NoLogin,
}

/// Error that can occur when we iterate through import directory
#[derive(Debug)]
pub enum FileIterationError {
	/// We have read all contents. not actually an error, but the signal that we finished
	SourceEnd,
	/// File read error
	FileReadError(PathBuf),
	/// failed to parse an eml.
	ParseError(PathBuf),
}

#[cfg(feature = "javascript")]
impl From<ImportError> for napi::Error {
	fn from(import_err: ImportError) -> Self {
		napi::Error::from_reason(format!("{:?}", import_err))
	}
}

#[cfg(feature = "javascript")]
impl From<PreparationError> for napi::Error {
	fn from(prep_err: PreparationError) -> Self {
		napi::Error::from_reason((prep_err as u8).to_string())
	}
}

impl ImportError {
	pub fn sdk(action: &'static str, error: ApiCallError) -> Self {
		Self::SdkError { action, error }
	}
}
