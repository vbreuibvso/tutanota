use crate::importer::importable_mail::{
	ImportableMailAttachment, ImportableMailAttachmentMetaData, KeyedImportableMailAttachment,
};
use crate::reduce_to_chunks::{AttachmentUploadData, KeyedImportMailData};
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use base64::Engine;
use file_reader::FileImport;
use imap_reader::ImapImport;
use imap_reader::ImapImportConfig;
use importable_mail::ImportableMail;
use std::ffi::OsStr;
use std::fs;
use std::fs::DirEntry;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tutasdk::blobs::blob_facade::FileData;
use tutasdk::crypto::aes;
use tutasdk::crypto::aes::Iv;
use tutasdk::crypto::key::{GenericAesKey, VersionedAesKey};
use tutasdk::crypto::randomizer_facade::RandomizerFacade;
use tutasdk::entities::generated::sys::{BlobReferenceTokenWrapper, StringWrapper};

use crate::importer::errors::{
	FileIterationError, ImapIterationError, ImportError, IterationError, PreparationError,
};
use crate::importer_api::TutaCredentials;
use tutasdk::entities::generated::tutanota::{
	ImportAttachment, ImportMailGetIn, ImportMailPostIn, ImportMailPostOut, ImportMailState,
};
use tutasdk::entities::json_size_estimator::estimate_json_size;
use tutasdk::net::native_rest_client::NativeRestClient;
use tutasdk::rest_error::PreconditionFailedReason::ImportFailure;
use tutasdk::rest_error::{HttpError, ImportFailureReason};
use tutasdk::services::generated::tutanota::ImportMailService;
use tutasdk::services::ExtraServiceParams;
use tutasdk::tutanota_constants::ArchiveDataType;
use tutasdk::{ApiCallError, CustomId, GeneratedId, IdTupleGenerated, LoggedInSdk};

pub mod errors;

pub mod file_reader;
pub mod imap_reader;
pub mod importable_mail;

#[cfg(not(test))]
pub const MAX_REQUEST_SIZE: usize = 1024 * 1024 * 8;
#[cfg(test)]
pub const MAX_REQUEST_SIZE: usize = 1024 * 5;

const STATE_ID_FILE_NAME: &str = "import_mail_state";

// We need this type because IdTupleGenerated cannot be converted to a napi value.
#[cfg_attr(feature = "javascript", napi_derive::napi(object))]
#[cfg_attr(test, derive(Debug))]
#[derive(Clone, PartialEq)]
pub struct ImportMailStateId {
	pub list_id: String,
	pub element_id: String,
}

#[derive(Clone, PartialEq)]
pub enum ImportParams {
	Imap {
		imap_import_config: ImapImportConfig,
	},
	LocalFile {
		file_path: String,
		is_mbox: bool,
	},
}

/// current state of the imap_reader import for this tuta account
/// requires an initialized SDK!
/// keep in sync with TutanotaConstants.ts
#[cfg_attr(feature = "javascript", napi_derive::napi)]
#[cfg_attr(not(feature = "javascript"), derive(Clone))]
#[derive(PartialEq, Default)]
#[cfg_attr(test, derive(Debug))]
#[repr(u8)]
pub enum ImportStatus {
	#[default]
	Running = 0,
	Paused = 1,
	Canceled = 2,
	Finished = 3,
}

impl TryFrom<i64> for ImportStatus {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(ImportStatus::Running),
            1 => Ok(ImportStatus::Paused),
            2 => Ok(ImportStatus::Canceled),
            3 => Ok(ImportStatus::Finished),
            _ => Err("Unknown import status"),
        }
    }
}

/// A running import can be stopped or paused
#[cfg_attr(feature = "javascript", napi_derive::napi)]
#[cfg_attr(not(feature = "javascript"), derive(Clone))]
#[derive(PartialEq)]
#[cfg_attr(test, derive(Debug))]
#[repr(u8)]
pub enum ImportProgressAction {
	Continue = 0,
	Pause = 1,
	Stop = 2,
}

/// when state callback function is called after every chunk of import,
/// javascript handle is expected to respond with this struct
#[cfg_attr(feature = "javascript", napi_derive::napi(object))]
#[cfg_attr(test, derive(Debug))]
pub struct StateCallbackResponse {
	pub action: ImportProgressAction,
}

pub struct ImportEssential {
	pub logged_in_sdk: Arc<LoggedInSdk>,
	target_owner_group: GeneratedId,
	mail_group_key: VersionedAesKey,
	pub remote_state_id: IdTupleGenerated,
	randomizer_facade: RandomizerFacade,
	pub(super) import_directory: PathBuf,
}

pub enum ImportSource {
	RemoteImap { imap_import_client: Box<ImapImport> },
	LocalFile { fs_email_client: FileImport },
}

impl Iterator for ImportSource {
	type Item = ImportableMail;

	fn next(&mut self) -> Option<Self::Item> {
		let next_importable_mail = match self {
			// the other way (converting fs_source to an async_iterator) would be nicer, but that's a nightly feature
			ImportSource::RemoteImap { imap_import_client } => imap_import_client
				.fetch_next_mail()
				.map_err(IterationError::Imap),
			ImportSource::LocalFile { fs_email_client } => fs_email_client
				.get_next_importable_mail()
				.map_err(IterationError::File),
		};

		match next_importable_mail {
			Ok(next_importable_mail) => Some(next_importable_mail),

			// source says, all the iteration have ended,
			Err(IterationError::File(FileIterationError::SourceEnd))
			| Err(IterationError::Imap(ImapIterationError::SourceEnd)) => None,

			Err(e) => {
				// once we handle this case we will need another iterator that filters (and logs) the
				// errors so we don't have to handle the error case during the chunking + upload
				panic!("Cannot get next email from source: {e:?}")
			},
		}
	}
}

impl ImportEssential {
	const IMPORT_DISABLED_ERROR: ApiCallError = ApiCallError::ServerResponseError {
		source: HttpError::PreconditionFailedError(Some(ImportFailure(
			ImportFailureReason::ImportDisabled,
		))),
	};

	pub async fn load_remote_state(&self) -> Result<ImportMailState, ApiCallError> {
        self.logged_in_sdk
            .mail_facade()
            .get_crypto_entity_client()
            .load::<ImportMailState, _>(&self.remote_state_id)
            .await
    }

	pub(super) async fn update_remote_state(
		&self,
		updater: impl Fn(&mut ImportMailState),
	) -> Result<(), ImportError> {
		let mut server_state = self
			.load_remote_state()
			.await
			.map_err(|e| ImportError::sdk("getting remote import state", e))?;

		updater(&mut server_state);

		self.logged_in_sdk
			.mail_facade()
			.get_crypto_entity_client()
			.update_instance(server_state)
			.await
			.map_err(|e| ImportError::sdk("update remote import state", e))
	}

	async fn upload_attachments_for_chunk(
		&self,
		importable_chunk: Vec<AttachmentUploadData>,
	) -> Result<Vec<KeyedImportMailData>, ImportError> {
		let mut upload_data_per_mail: Vec<(Vec<FileData>, Vec<ImportableMailAttachmentMetaData>)> =
			Vec::with_capacity(importable_chunk.len());
		let attachments_count_per_mail: Vec<usize> = importable_chunk
			.iter()
			.map(|mail| mail.attachments.len())
			.collect();

		// aggregate attachment data from multiple mails to upload in fewer request to the BlobService
		let (attachments_per_mail, keyed_import_mail_data): (
			Vec<Vec<ImportableMailAttachment>>,
			Vec<KeyedImportMailData>,
		) = importable_chunk
			.into_iter()
			.map(|mail| (mail.attachments, mail.keyed_import_mail_data))
			.unzip();

		for attachments_next_mail in attachments_per_mail {
			if !attachments_next_mail.is_empty() {
				let keyed_attachments: Vec<KeyedImportableMailAttachment> = attachments_next_mail
					.into_iter()
					.map(|attachment| attachment.make_keyed_importable_mail_attachment(self))
					.collect();

				let (attachments_file_data, attachments_meta_data): (
					Vec<FileData>,
					Vec<ImportableMailAttachmentMetaData>,
				) = keyed_attachments
					.into_iter()
					.map(|keyed_attachment| {
						let file_datum = FileData {
							session_key: keyed_attachment.attachment_session_key,
							data: keyed_attachment.content,
						};
						(file_datum, keyed_attachment.meta_data)
					})
					.unzip();
				upload_data_per_mail.push((attachments_file_data, attachments_meta_data))
			} else {
				// attachments_next_mail is empty we push empty vectors in order to maintain
				// correct order of blob reference tokens across different attachments and mails
				// these empty vectors indicate
				// * an empty list of attachments
				// * and an empty list of corresponding attachment metadata for this mail
				upload_data_per_mail.push((vec![], vec![]));
			}
		}

		let (attachments_file_data_per_mail, attachments_meta_data_per_mail): (
			Vec<Vec<FileData>>,
			Vec<Vec<ImportableMailAttachmentMetaData>>,
		) = upload_data_per_mail.into_iter().unzip();

		let attachments_file_data_flattened: Vec<&FileData> =
			attachments_file_data_per_mail.iter().flatten().collect();

		// upload all attachments in this chunk in one call to the blob_facade
		// the blob_facade chunks them into efficient request to the BlobService
		let mut reference_tokens_per_attachment_flattened = self
			.logged_in_sdk
			.blob_facade()
			.encrypt_and_upload_multiple(
				ArchiveDataType::Attachments,
				&self.target_owner_group,
				attachments_file_data_flattened,
			)
			.await
			.map_err(|e| ImportError::sdk("fail to upload multiple attachments", e))?;

		// reference mails and received reference tokens, by using the attachments count per mail
		let mut all_reference_tokens_per_mail: Vec<Vec<Vec<BlobReferenceTokenWrapper>>> = vec![];
		for attachments_count in attachments_count_per_mail {
			if attachments_count == 0 {
				all_reference_tokens_per_mail.push(vec![]);
			} else {
				let reference_tokens_per_mail = reference_tokens_per_attachment_flattened
					.drain(..attachments_count)
					.collect();
				all_reference_tokens_per_mail.push(reference_tokens_per_mail);
			}
		}

		let import_attachments_per_mail: Vec<Vec<ImportAttachment>> =
			attachments_file_data_per_mail
				.into_iter()
				.zip(
					attachments_meta_data_per_mail
						.into_iter()
						.zip(all_reference_tokens_per_mail),
				)
				.map(
					|(file_data, (meta_data, reference_tokens_per_attachment))| {
						file_data
							.into_iter()
							.zip(meta_data.into_iter().zip(reference_tokens_per_attachment))
							.map(|(file_datum, (meta_datum, reference_tokens))| {
								meta_datum.make_import_attachment_data(
									self,
									&file_datum.session_key,
									reference_tokens,
								)
							})
							.collect()
					},
				)
				.collect();

		let unit_import_results = keyed_import_mail_data
			.into_iter()
			.zip(import_attachments_per_mail)
			.map(|(mut unit_import, import_attachments)| {
				unit_import.import_mail_data.importedAttachments = import_attachments;
				unit_import
			})
			.collect();

		Ok(unit_import_results)
	}

	async fn make_serialized_chunk(
		&self,
		importable_chunk: Vec<KeyedImportMailData>,
	) -> Result<(ImportMailPostIn, GenericAesKey), ImportError> {
		let mut serialized_imports = Vec::with_capacity(importable_chunk.len());

		for unit_import in importable_chunk {
			let serialized_import = self
				.logged_in_sdk
				.serialize_instance_to_json(unit_import.import_mail_data, unit_import.session_key)
				.map_err(|e| ImportError::sdk("serializing instance to json", e))?;
			let wrapped_import_data = StringWrapper {
				_id: Some(Importer::make_random_aggregate_id(&self.randomizer_facade)),
				value: serialized_import,
			};
			serialized_imports.push(wrapped_import_data);
		}

		let session_key = GenericAesKey::Aes256(aes::Aes256Key::generate(&self.randomizer_facade));
		let post_in = ImportMailPostIn {
			encImports: serialized_imports,
			mailState: self.remote_state_id.clone(),
			_format: 0,
		};

		Ok((post_in, session_key))
	}

	// distribute load across the cluster. should be switched to read token (once it is implemented on the
	// BlobFacade) and use ArchiveDataType::MailDetails to target one of the nodes that actually stores the
	// data
	async fn get_server_url_to_upload(&self) -> Result<String, ImportError> {
		self.logged_in_sdk
			.request_blob_facade_write_token(ArchiveDataType::Attachments)
			.await
			.map_err(|e| ImportError::sdk("request blob write token", e))?
			.servers
			.last()
			.map(|s| s.url.to_string())
			.ok_or(ImportError::EmptyBlobServerList)
	}

	async fn make_import_service_call(
		&self,
		import_mail_data: (ImportMailPostIn, GenericAesKey),
	) -> Result<ImportMailPostOut, ImportError> {
		let server_to_upload = self.get_server_url_to_upload().await?;
		let (import_mail_post_in, session_key_for_import_post) = import_mail_data;

		self.logged_in_sdk
			.get_service_executor()
			.post::<ImportMailService>(
				import_mail_post_in,
				ExtraServiceParams {
					base_url: Some(server_to_upload),
					session_key: Some(session_key_for_import_post),
					..Default::default()
				},
			)
			.await
			.map_err(|e| ImportError::sdk("calling ImportMailService", e))
	}

	pub async fn create_new_server_import_state(
		logged_in_sdk: &LoggedInSdk,
		randomizer_facade: &RandomizerFacade,
		mail_group_key: VersionedAesKey,
		target_owner_group: GeneratedId,
		target_mailset: IdTupleGenerated,
		total_importable_mails: i64,
	) -> Result<IdTupleGenerated, PreparationError> {
		let session_key = GenericAesKey::Aes256(aes::Aes256Key::generate(randomizer_facade));
		let owner_enc_sk_for_import_state_get =
			mail_group_key.encrypt_key(&session_key, Iv::generate(randomizer_facade));
		let import_mail_get_in = ImportMailGetIn {
			_format: 0,
			newImportedMailSetName: "@internal-mailset".to_string(),
			ownerEncSessionKey: owner_enc_sk_for_import_state_get.object,
			ownerGroup: target_owner_group,
			ownerKeyVersion: owner_enc_sk_for_import_state_get.version,
			totalMails: total_importable_mails,
			targetMailFolder: target_mailset,
			_errors: None,
			_finalIvs: Default::default(),
		};

		let import_get_response = logged_in_sdk
			.get_service_executor()
			.get::<ImportMailService>(
				import_mail_get_in,
				ExtraServiceParams {
					session_key: Some(session_key),
					..Default::default()
				},
			)
			.await
			.map_err(|e| {
				log::error!("Can not get:: on ImportMailService: {e:?}");

				(e == Self::IMPORT_DISABLED_ERROR)
					.then_some(PreparationError::NoImportFeature)
					.unwrap_or(PreparationError::CannotLoadRemoteState)
			})?;

		Ok(import_get_response.mailState)
	}
}

pub struct Importer {
	pub(super) essentials: ImportEssential,
	next_progress_action: napi::tokio::sync::Mutex<ImportProgressAction>,
	chunked_import_source: napi::tokio::sync::Mutex<
		super::reduce_to_chunks::Butcher<{ MAX_REQUEST_SIZE }, AttachmentUploadData>,
	>,
}
impl Importer {
	fn make_random_aggregate_id(randomizer_facade: &RandomizerFacade) -> CustomId {
		let new_id_bytes = randomizer_facade.generate_random_array::<4>();
		let new_id_string = BASE64_URL_SAFE_NO_PAD.encode(new_id_bytes);
		CustomId(new_id_string)
	}

	pub(super) async fn set_next_progress_action(&self, action: ImportProgressAction) {
		*self.next_progress_action.lock().await = action;
	}

	/// called to start a completely new import, not on resume
	pub(super) async fn create_new_file_importer(
		logged_in_sdk: Arc<LoggedInSdk>,
		target_owner_group: GeneratedId,
		target_mailset: IdTupleGenerated,
		import_directory: PathBuf,
	) -> Result<Importer, PreparationError> {
		let eml_files_to_import: Vec<PathBuf> = Self::eml_files_in_directory(&import_directory)
			.map_err(|_| PreparationError::FailedToReadEmls)?;
		let total_importable_mails = eml_files_to_import.len() as i64;

		let import_source = ImportSource::LocalFile {
			fs_email_client: FileImport::new(eml_files_to_import),
		};

		Importer::initialize(
			logged_in_sdk,
			None,
			import_source,
			target_owner_group,
			import_directory,
			target_mailset,
			total_importable_mails,
		)
		.await
	}

	pub(super) async fn create_sdk(
		tuta_credentials: TutaCredentials,
	) -> Result<Arc<LoggedInSdk>, PreparationError> {
		let base_url = tuta_credentials.api_url.clone();
		let rest_client = NativeRestClient::try_new().map_err(|e| {
			log::error!("Can not create new native rest client: {e:?}");
			PreparationError::NoNativeRestClient
		})?;

		let sdk_credentials = tuta_credentials
			.try_into()
			.map_err(|_validation_error| PreparationError::CredentialValidationError)?;

		let logged_in_sdk = tutasdk::Sdk::new(base_url, Arc::new(rest_client))
			.login(sdk_credentials)
			.await
			.map_err(|e| {
				log::error!("Can not login to sdk: {e:?}");
				PreparationError::LoginError
			})?;

		Ok(logged_in_sdk)
	}

	fn eml_files_in_directory(directory: &Path) -> std::io::Result<Vec<PathBuf>> {
		Ok(fs::read_dir(&directory)?
			.collect::<std::io::Result<Vec<DirEntry>>>()?
			.iter()
			.map(DirEntry::path)
			.filter(|path| path.extension() == Some(OsStr::new("eml")))
			.collect())
	}

	pub(super) async fn resume_file_importer(
		mailbox_id: &str,
		config_directory: String,
		target_owner_group: GeneratedId,
		tuta_credentials: TutaCredentials,
		import_state_id: IdTupleGenerated,
	) -> Result<Importer, PreparationError> {
		let import_directory = FileImport::make_import_directory(&config_directory, mailbox_id);

		let eml_files_to_import = Self::eml_files_in_directory(import_directory.as_path())
			.map_err(|_| PreparationError::FailedToReadEmls)?;
		let total_importable_mails = eml_files_to_import.len() as i64;
		let import_source = ImportSource::LocalFile {
			fs_email_client: FileImport::new(eml_files_to_import),
		};

		let logged_in_sdk = Self::create_sdk(tuta_credentials).await?;
		let remote_import_state = logged_in_sdk
			.mail_facade()
			.get_crypto_entity_client()
			.load::<ImportMailState, _>(&import_state_id)
			.await
			.map_err(|e| {
				log::error!("Can not load remote import state: {e:?}");
				PreparationError::CannotLoadRemoteState
			})?;

		let target_mailset = remote_import_state.targetFolder;

		let importer = Importer::initialize(
			logged_in_sdk,
			Some(import_state_id),
			import_source,
			target_owner_group,
			import_directory,
			target_mailset,
			total_importable_mails,
		)
		.await?;
		Ok(importer)
	}

	pub(super) async fn initialize(
		logged_in_sdk: Arc<LoggedInSdk>,
		remote_state_id: Option<IdTupleGenerated>,
		import_source: ImportSource,
		target_owner_group: GeneratedId,
		import_directory: PathBuf,
		target_mailset: IdTupleGenerated,
		total_importable_mails: i64,
	) -> Result<Importer, PreparationError> {
		let mail_group_key = logged_in_sdk
			.get_current_sym_group_key(&target_owner_group)
			.await
			.map_err(|e| {
				eprintln!("Can not load mail group key: {e:?}");
				PreparationError::NoMailGroupKey
			})?;

		// the key is not copy and we want to re-use it after moving it into the map fn
		// not using a move closure also doesn't work since we don't want to collect the iterator here.
		let mail_group_key_clone = mail_group_key.clone();
		let attachment_upload_data = import_source.into_iter().map(move |importable_mail| {
			let my_key = mail_group_key_clone.clone();
			AttachmentUploadData::create_from_importable_mail(
				&RandomizerFacade::from_core(rand::rngs::OsRng),
				&my_key,
				importable_mail,
			)
		});
		let chunked_mails_provider = super::reduce_to_chunks::Butcher::new(
			Box::new(attachment_upload_data),
			|upload_data| estimate_json_size(&upload_data.keyed_import_mail_data.import_mail_data),
		);
		let chunked_mails_provider = napi::tokio::sync::Mutex::new(chunked_mails_provider);

		let randomizer_facade = RandomizerFacade::from_core(rand::rngs::OsRng);

		let remote_state_id = match remote_state_id {
			Some(remote_state_id) => remote_state_id,
			None => {
				ImportEssential::create_new_server_import_state(
					&logged_in_sdk,
					&randomizer_facade,
					mail_group_key.clone(),
					target_owner_group.clone(),
					target_mailset,
					total_importable_mails,
				)
				.await?
			},
		};

		let state_file_path = import_directory.join(STATE_ID_FILE_NAME);
        fs::write(
            state_file_path,
            format!("{}/{}", remote_state_id.list_id, remote_state_id.element_id),
        )
		.map_err(|_| PreparationError::StateFileWriteFailed)?;

		let import_essentials = ImportEssential {
			logged_in_sdk,
			target_owner_group,
			mail_group_key,
			randomizer_facade,
			remote_state_id,
			import_directory,
		};

		let importer = Importer {
			chunked_import_source: chunked_mails_provider,
			essentials: import_essentials,
			next_progress_action: napi::tokio::sync::Mutex::new(ImportProgressAction::Continue),
		};
		Ok(importer)
	}

	pub async fn import_next_chunk(&self) -> Result<bool, ImportError> {
		let import_essentials = &self.essentials;
		let Self {
			chunked_import_source,
			..
		} = self;

		let next_chunk_to_import = chunked_import_source.lock().await.next();
		match next_chunk_to_import {
			// everything have been finished
			None => Ok(true),

			// this chunk was too big to import
			Some(Err(_too_big_chunk)) => {
				self.essentials
					.update_remote_state(|remote_state| {
						remote_state.failedMails += 1;
					})
					.await?;
				Err(ImportError::TooBigChunk)?
			},

			// these chunks can be imported in single request
			Some(Ok(chunked_import_data)) => {
				let import_count_in_this_chunk: i64 = chunked_import_data
					.len()
					.try_into()
					.expect("item count in single chunk will never exceed i64::max");

				let eml_file_paths: Vec<Option<PathBuf>> = chunked_import_data
					.iter()
					.map(|id| id.keyed_import_mail_data.eml_file_path.clone())
					.collect();

				let mut failed_count: i64 = 0;
				let unit_import_data = import_essentials
					.upload_attachments_for_chunk(chunked_import_data)
					.await
					.inspect_err(|_e| failed_count += import_count_in_this_chunk)?;
				let importable_post_data = import_essentials
					.make_serialized_chunk(unit_import_data)
					.await
					.inspect_err(|_e| failed_count += import_count_in_this_chunk)?;

				import_essentials
					.make_import_service_call(importable_post_data)
					.await
					.inspect_err(|_e| failed_count += import_count_in_this_chunk)?;

				self.essentials
					.update_remote_state(move |state| {
						state.failedMails += failed_count;
						state.successfulMails += import_count_in_this_chunk;
					})
					.await?;
				for eml_file_path in eml_file_paths.into_iter().flatten() {
					fs::remove_file(&eml_file_path)
						.map_err(|e| ImportError::FileDeletionError(e, eml_file_path))?;
				}

				Ok(false)
			},
		}
	}

	pub(super) async fn set_remote_import_status(
		&self,
		exit_import_status: ImportStatus,
	) -> Result<(), ImportError> {
		match exit_import_status {
			terminal_status @ (ImportStatus::Finished | ImportStatus::Canceled) => {
				FileImport::delete_dir_if_exists(&self.essentials.import_directory).ok();
				self.essentials
					.update_remote_state(|remote_state| {
						remote_state.status = terminal_status as i64;
					})
					.await
			},
			ImportStatus::Paused => {
				self.essentials
					.update_remote_state(|remote_state| {
						remote_state.status = ImportStatus::Paused as i64;
					})
					.await
			},
			ImportStatus::Running => {
				self.essentials
					.update_remote_state(|remote_state| {
						remote_state.status = ImportStatus::Running as i64;
					})
					.await
			},
		}
	}

	pub async fn start_stateful_import(&self) -> Result<(), ImportError> {
		loop {
			let requested_progress_action = *self.next_progress_action.lock().await;
			match requested_progress_action {
				ImportProgressAction::Pause | ImportProgressAction::Stop => break,
				ImportProgressAction::Continue => {
					let import_chunk_res = self.import_next_chunk().await;

					match import_chunk_res {
						Ok(true) => {
							self.set_remote_import_status(ImportStatus::Finished)
								.await?;
							break;
						},
						Ok(false) => {},

						Err(e) => {
							self.handle_err_while_importing_chunk(e)?;
						},
					}
				},
			}
		}

		Ok(())
	}

	fn handle_err_while_importing_chunk(
		&self,
		import_error: ImportError,
	) -> Result<(), ImportError> {
		// todo: review
		match import_error {
			ImportError::NoImportFeature => Err(ImportError::NoImportFeature),

			ImportError::SdkError {
				action: _,
				error: _,
			} => {
				// todo:
				// what to do here?
				Ok(())
			},

			ImportError::EmptyBlobServerList => {
				// todo:
				// should be enough to retry?
				// at what case can server answer the request but return empty list?
				Err(ImportError::EmptyBlobServerList)
			},
			ImportError::LocalImportStateIdInvalid => {
				// since the id file itself is corrupted, we can not do anything about it,
				// instead show user import directory and ask them to delete the directory manually
				Err(ImportError::LocalImportStateIdInvalid)
			},

			ImportError::IterationError(e) => {
				// probably we can just continue to iterate through the source,
				// downside: we might lose this item and when we finish we empty the dir,
				// do this item just got lost in void
				Ok(())
			},

			ImportError::TooBigChunk => {
				// we can continue ad this chunk will be added to failed mails count
				Ok(())
			},
			ImportError::FileDeletionError(_, _) => {
				// we can not delete the file after we imported it,
				// best case: everything else is fine and import is finished/canceled so we just delete the whole dir
				// worst case: use pause/resume ( or quit the app and open again ) and the imported chunk will be imported again
				Ok(())
			},
		}
	}

	pub(super) fn existing_import(
		import_directory: &Path,
	) -> std::io::Result<Option<IdTupleGenerated>> {
		let state_file_path = import_directory.join(STATE_ID_FILE_NAME);

		if !state_file_path.try_exists()? {
			return Ok(None);
		}

		let id_tuple_str = fs::read_to_string(&state_file_path)?;
		let [list_id, element_id] = id_tuple_str
			.split("/")
			.map(String::from)
			.collect::<Vec<_>>()
			.try_into()
			.map_err(|_e| std::io::ErrorKind::InvalidData)?;

		let id_tuple = IdTupleGenerated::new(GeneratedId(list_id), GeneratedId(element_id));
		Ok(Some(id_tuple))
	}

	// todo: use this function to do certain task that have very minimal chances of failure?
	// example: deleting file, copying file, loading state from server
	// keep executing the action Nth time maximum until we get Ok()
	pub fn do_until_ok<const MAX_LIMIT: usize, O, E>(
		action: impl Fn() -> Result<O, E>,
	) -> Result<O, E> {
		let mut last_result = action();

		for _ in 1..=MAX_LIMIT {
			last_result = action();
			if last_result.is_ok() {
				return last_result;
			}
		}

		last_result
	}
}

impl From<IdTupleGenerated> for ImportMailStateId {
	fn from(id_tuple: IdTupleGenerated) -> Self {
		Self {
			list_id: id_tuple.list_id.to_string(),
			element_id: id_tuple.element_id.to_string(),
		}
	}
}

impl From<ImportMailStateId> for IdTupleGenerated {
	fn from(id_tuple: ImportMailStateId) -> Self {
		Self {
			list_id: GeneratedId::from(id_tuple.list_id),
			element_id: GeneratedId::from(id_tuple.element_id),
		}
	}
}

#[cfg(test)]
#[cfg(not(ci))]
mod tests {
	use super::*;

	use crate::test_utils::CleanDir;
	use mail_builder::MessageBuilder;
	use std::sync::Mutex;
	use tutasdk::entities::generated::tutanota::MailFolder;
	use tutasdk::folder_system::MailSetKind;
	use tutasdk::net::native_rest_client::NativeRestClient;
	use tutasdk::Sdk;

	const IMPORTED_MAIL_ADDRESS: &str = "map-premium@tutanota.de";

	fn get_test_id() -> u32 {
		static TEST_COUNTER: Mutex<u32> = Mutex::new(0);
		let mut old_count_guard = TEST_COUNTER.lock().expect("Mutex poisoned");
		let new_count = old_count_guard.checked_add(1).unwrap();
		*old_count_guard = new_count;
		drop(old_count_guard);
		new_count
	}

	fn sample_email(subject: String) -> String {
		let email = MessageBuilder::new()
            .from(("Matthias", "map@example.org"))
            .to(("Johannes", "jhm@example.org"))
            .subject(subject)
            .text_body("Hello tutao! this is the first step to have email import.Want to see html 😀?<p style='color:red'>red</p>")
            .write_to_string()
            .unwrap();
		email
	}

	async fn get_test_import_folder_id(
		logged_in_sdk: &Arc<LoggedInSdk>,
		kind: MailSetKind,
	) -> MailFolder {
		let mail_facade = logged_in_sdk.mail_facade();
		let mailbox = mail_facade.load_user_mailbox().await.unwrap();
		let folders = mail_facade
			.load_folders_for_mailbox(&mailbox)
			.await
			.unwrap();
		folders
			.system_folder_by_type(kind)
			.expect("inbox should exist")
			.clone()
	}

	pub async fn init_file_importer(source_paths: Vec<&str>) -> Importer {
		let logged_in_sdk = Sdk::new(
			"http://localhost:9000".to_string(),
			Arc::new(NativeRestClient::try_new().unwrap()),
		)
		.create_session(IMPORTED_MAIL_ADDRESS, "map")
		.await
		.unwrap();
		let mailbox_id = logged_in_sdk
			.mail_facade()
			.load_user_mailbox()
			.await
			.unwrap()
			._id
			.as_ref()
			.unwrap()
			.clone();
		let target_mailset = get_test_import_folder_id(&logged_in_sdk, MailSetKind::Archive)
			.await
			._id
			.unwrap();
		let target_owner_group = logged_in_sdk
			.mail_facade()
			.get_group_id_for_mail_address(IMPORTED_MAIL_ADDRESS)
			.await
			.unwrap();

		let files = source_paths.into_iter().map(|file_name| {
			PathBuf::from(format!(
				"{}/tests/resources/testmail/{file_name}",
				env!("CARGO_MANIFEST_DIR")
			))
		});
		let config_directory: PathBuf = format!("/tmp/import_test_{}", get_test_id()).into();
		let import_directory = FileImport::prepare_file_import(
			config_directory.to_str().unwrap(),
			mailbox_id.as_str(),
			files,
		)
		.unwrap();

		fs::create_dir_all(&config_directory).unwrap();

		Importer::create_new_file_importer(
			logged_in_sdk,
			target_owner_group,
			target_mailset,
			import_directory,
		)
		.await
		.unwrap()
	}

	#[tokio::test]
	async fn can_import_single_eml_file_without_attachment() {
		let importer = init_file_importer(vec!["sample.eml"]).await;
		importer.start_stateful_import().await.unwrap();

		let remote_state = importer.essentials.load_remote_state().await.unwrap();
		assert_eq!(remote_state.status, ImportStatus::Finished as i64);
		assert_eq!(remote_state.failedMails, 0);
		assert_eq!(remote_state.successfulMails, 1);
	}

	#[tokio::test]
	async fn can_import_single_eml_file_with_attachment() {
		let importer = init_file_importer(vec!["attachment_sample.eml"]).await;
		importer.start_stateful_import().await.unwrap();

		let remote_state = importer.essentials.load_remote_state().await.unwrap();
		assert_eq!(remote_state.status, ImportStatus::Finished as i64);
		assert_eq!(remote_state.failedMails, 0);
		assert_eq!(remote_state.successfulMails, 1);
	}

	#[tokio::test]
	#[ignore = "present for jhm and sug"]
	async fn should_stop_if_on_stop_action() {
		let importer = init_file_importer(vec!["sample.eml"; 3]).await;

		importer.start_stateful_import().await.unwrap();

		let remote_state = importer.essentials.load_remote_state().await.unwrap();
		assert_eq!(remote_state.status, ImportStatus::Canceled as i64);
		assert_eq!(remote_state.failedMails, 0);
		assert_eq!(remote_state.successfulMails, 1);
	}

	#[test]
	fn max_request_size_in_test_is_different() {
		assert_eq!(1024 * 5, MAX_REQUEST_SIZE);
	}

	#[tokio::test]
	async fn existing_import_should_be_none_if_no_state_file() {
		let config_dir_string = "/tmp/existing_import_should_be_none_if_no_state_file";
		let mailbox_id = "some_mailbox_id";
		let import_dir: PathBuf = [
			config_dir_string.to_string(),
			"current_imports".to_string(),
			mailbox_id.to_string(),
		]
		.iter()
		.collect();

		let result = Importer::existing_import(&import_dir);
		assert!(matches!(result, Ok(None)));
	}

	#[tokio::test]
	async fn get_resumable_state_id_invalid_content() {
		let config_dir_string = "/tmp/get_resumable_state_id_invalid_content";
		let mailbox_id = "some_mailbox_id";
		let import_dir: PathBuf = [
			config_dir_string.to_string(),
			"current_imports".to_string(),
			mailbox_id.to_string(),
		]
		.iter()
		.collect();
		let config_dir = PathBuf::from(config_dir_string);

		let _tear_down = CleanDir {
			dir: config_dir.clone(),
		};

		if !import_dir.exists() {
			fs::create_dir_all(&import_dir).unwrap();
		}
		let mut state_id_file_path = import_dir.clone();
		state_id_file_path.push(STATE_ID_FILE_NAME);
		let invalid_id = "blah";
		fs::write(&state_id_file_path, invalid_id).unwrap();

		let result = Importer::existing_import(&import_dir).unwrap_err().kind();
		assert_eq!(result, std::io::ErrorKind::InvalidData);
	}
}
