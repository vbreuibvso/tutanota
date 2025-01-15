use crate::importer::errors::{FileIterationError, PreparationError};
use crate::importer::importable_mail::ImportableMail;
use crate::importer::STATE_ID_FILE_NAME;
use mail_parser::mailbox::mbox::MessageIterator;
use mail_parser::MessageParser;
use std::fs;
use std::io::BufReader;
use std::path::PathBuf;

pub struct FileImport {
	eml_sources: Vec<PathBuf>,
	message_parser: MessageParser,
}

struct SourceEml {
	file_content: Vec<u8>,
	eml_file_path: PathBuf,
}

impl FileImport {
	fn next_eml_contents(&mut self) -> Result<SourceEml, FileIterationError> {
		let eml_file_path = self
			.eml_sources
			.pop()
			.ok_or(FileIterationError::SourceEnd)?;
		let file_content = fs::read(&eml_file_path)
			.map_err(|_read_err| FileIterationError::FileReadError(eml_file_path.clone()))?;
		Ok(SourceEml {
			file_content,
			eml_file_path,
		})
	}
}

impl FileImport {
	pub fn new(eml_sources: Vec<PathBuf>) -> Self {
		let message_parser = MessageParser::default();
		Self {
			eml_sources,
			message_parser,
		}
	}

	/// Convert mbox files to eml and copy all eml files to target_folder.
	/// During the import, eml files are deleted from target_folder after they were imported.
	/// so that we can keep track of files that failed to import and allow resuming the import.
	/// returns the import directory where the EMLs and the remote import state id is stored.
	pub(crate) fn prepare_file_import(
		config_directory: &str,
		mailbox_id: &str,
		source_paths: impl Iterator<Item = PathBuf>,
	) -> Result<PathBuf, PreparationError> {
		let import_directory_path = FileImport::make_import_directory(config_directory, mailbox_id);

		// start clean import,
		// example: import_state id file is not there but some eml files are,
		// in that case we don't want to include those eml in this import
		FileImport::delete_dir_if_exists(&import_directory_path)
			.map_err(|_| PreparationError::CanNotDeleteImportDir)?;

		fs::create_dir_all(&import_directory_path)
			.map_err(|_| PreparationError::CanNotCreateImportDir)?;
		let mut file_counter = 0;

		for source_path in source_paths {
			let is_mbox_file = source_path.extension() == Some("mbox".as_ref());
			let is_eml_file = source_path.extension() == Some("eml".as_ref());

			if is_mbox_file {
				let file_buf_reader =
					fs::File::open(&source_path)
						.map(BufReader::new)
						.map_err(|read_err| {
							log::error!("Can not read file: {source_path:?}. Error: {read_err:?}");
							PreparationError::FileReadError
						})?;

				let msg_iterator = MessageIterator::new(file_buf_reader);
				for parsed_message in msg_iterator {
					let target_eml_file_path =
						import_directory_path.join(file_counter.to_string() + ".eml");
					let parsed_message = parsed_message.map_err(|parse_err| {
						log::error!("Can not parse a message from mbox: {parse_err:?}");
						PreparationError::NotAValidEmailFile
					})?;

					fs::write(&target_eml_file_path, parsed_message.contents()).map_err(
						|write_e| {
							log::error!("Can not write deconstructed eml: {file_counter}. Error: {write_e:?}");
							PreparationError::EmlFileWriteFailure
						},
					)?;

					file_counter += 1;
				}
			} else if is_eml_file {
				let target_eml_file_path =
					import_directory_path.join(file_counter.to_string() + ".eml");
				fs::copy(&source_path, &target_eml_file_path).map_err(|copy_err| {
					log::error!("Can not copy eml: {source_path:?}. Error: {copy_err:?}");
					PreparationError::EmlFileWriteFailure
				})?;

				file_counter += 1;
			} else {
				// we're ignoring files that are not eml or mbox because we try to
				// configure the dialog to only allow selecting those.
				// user probably uses some weird setup.
			}
		}

		Ok(import_directory_path)
	}

	/// Get next importable mail form sources,
	/// will try to exhaust eml_sources first
	pub fn get_next_importable_mail(&mut self) -> Result<ImportableMail, FileIterationError> {
		// Get next item from eml source first. once all eml sources are exhausted,
		// move to next mbox sources,
		let eml = self.next_eml_contents()?;

		self.message_parser
			.parse(eml.file_content.as_slice())
			.map(|parsed_message| {
				ImportableMail::convert_from(&parsed_message, Some(eml.eml_file_path.clone()))
			})
			.ok_or(FileIterationError::ParseError(eml.eml_file_path))
	}

	/// recursively deletes the given directory and its contents
	pub fn delete_dir_if_exists(target_dir: &PathBuf) -> std::io::Result<()> {
		target_dir
			.exists()
			.then(|| fs::remove_dir_all(target_dir))
			.unwrap_or(Ok(()))
	}

	/// makes a best-effort attempt to make the state in the given target directory
	/// look like there is no ongoing import anymore, but will ignore errors.
	pub fn clean_import_directory(import_dir: &PathBuf) {
		fs::remove_file(import_dir.join(STATE_ID_FILE_NAME)).ok();
		FileImport::delete_dir_if_exists(import_dir).ok();
	}
	pub fn make_import_directory(config_directory: &str, mailbox_id: &str) -> PathBuf {
		[
			config_directory.to_string(),
			"current_imports".into(),
			mailbox_id.to_string(),
		]
		.iter()
		.collect()
	}
}

#[cfg(test)]
mod test {
	use crate::importer::file_reader::FileImport;
	use crate::importer::{Importer, STATE_ID_FILE_NAME};
	use std::fs;
	use std::fs::File;
	use std::io::Write;
	use std::path::PathBuf;
	use std::sync::Mutex;
	use tutasdk::{GeneratedId, IdTupleGenerated};

	struct Setup {
		reply_path: PathBuf,
		msg_path: PathBuf,
		mbox_path: PathBuf,
		src_folder: PathBuf,
		config_directory: PathBuf,
	}

	fn get_test_id() -> u32 {
		static TEST_COUNTER: Mutex<u32> = Mutex::new(0);
		let mut old_count_guard = TEST_COUNTER.lock().expect("Mutex poisoned");
		let new_count = old_count_guard.checked_add(1).unwrap();
		*old_count_guard = new_count;
		drop(old_count_guard);
		new_count
	}
	impl Setup {
		fn new() -> Setup {
			let test_id = get_test_id();
			let src_folder: PathBuf = format!("/tmp/import_src_{:?}", test_id).into();
			let config_directory: PathBuf = format!("/tmp/import_target_{:?}", test_id).into();

			fs::create_dir_all(&src_folder).unwrap();
			let mut msg_path = src_folder.clone();
			msg_path.push("msg.eml");
			File::create(&msg_path)
				.unwrap()
				.write_all(EML_MSG.as_bytes())
				.unwrap();
			let mut reply_path = src_folder.clone();
			reply_path.push("reply.eml");
			File::create(&reply_path)
				.unwrap()
				.write_all(EML_REPLY.as_bytes())
				.unwrap();
			let mut mbox_path = src_folder.clone();
			mbox_path.push("mbox.mbox");
			let mbox_contents = "From vr@tuta.io  Fri Feb  2 20:57:39 2024\n".to_string()
				+ EML_MSG
				+ "\n\nFrom freepancakes@tutanota.com  Fri Feb  2 21:03:27 2024\n"
				+ EML_REPLY;
			File::create(&mbox_path)
				.unwrap()
				.write_all(mbox_contents.as_bytes())
				.unwrap();
			Setup {
				src_folder,
				config_directory,
				msg_path,
				reply_path,
				mbox_path,
			}
		}
	}
	impl Drop for Setup {
		fn drop(&mut self) {
			match fs::remove_dir_all(self.src_folder.clone()) {
				Ok(_) => {},
				Err(_e) => println!("can't delete src_folder {:?}", self.src_folder),
			}
			fs::remove_dir_all(self.config_directory.clone())
				.map_err(|_e| println!("can't delete target_folder {:?}", self.config_directory))
				.unwrap();
		}
	}

	const EML_MSG: &str = r#"From: vr@tuta.io
MIME-Version: 1.0
Subject: Virtual Reality Food
Date: Fri, 25 Oct 2024 08:15:39 +0000
Content-Type: text/plain; charset=UTF-8

Did you already try the new street food in VR?
		"#;

	const EML_REPLY: &str = r#"From: freepancakes@tutanota.com
MIME-Version: 1.0
Subject: RE: Virtual Reality Food
Date: Fri, 25 Oct 2024 08:15:39 +0000
Content-Type: text/plain; charset=UTF-8

> Did you already try the new street food in VR?

Yeah, but I really did not like it. Had higher hopes after watching that Simpsons episode...
		"#;

	#[test]
	pub fn prepare_import_eml() {
		let s = Setup::new();
		let import_directory = FileImport::prepare_file_import(
			s.config_directory.to_string_lossy().as_ref(),
			"someId",
			vec![s.msg_path.clone(), s.reply_path.clone()].into_iter(),
		)
		.unwrap();
		let eml_files = Importer::eml_files_in_directory(&import_directory).unwrap();
		if let [msg_path, reply_path] = eml_files.as_slice() {
			verify_file_contents(
				msg_path,
				&[&import_directory, &"0.eml".into()].into_iter().collect(),
				EML_MSG,
			);
			verify_file_contents(
				reply_path,
				&[&import_directory, &"1.eml".into()].iter().collect(),
				EML_REPLY,
			);
		} else {
			panic!("unexpected eml files {:?}", eml_files);
		}
	}

	#[test]
	pub fn prepare_import_mbox() {
		let s = Setup::new();
		let import_directory = FileImport::prepare_file_import(
			s.config_directory.to_string_lossy().as_ref(),
			"anotherId",
			vec![s.msg_path.clone(), s.reply_path.clone()].into_iter(),
		)
		.unwrap();

		let eml_files = Importer::eml_files_in_directory(&import_directory).unwrap();
		if let [msg_path, reply_path] = eml_files.as_slice() {
			verify_file_contents(
				msg_path,
				&[&import_directory, &"0.eml".into()].into_iter().collect(),
				EML_MSG,
			);
			verify_file_contents(
				reply_path,
				&[&import_directory, &"1.eml".into()].iter().collect(),
				EML_REPLY,
			);
		} else {
			panic!("unexpected eml files {:?}", eml_files);
		}
	}

	#[test]
	pub fn prepare_import_eml_and_mbox() {
		let s = Setup::new();
		let import_directory = FileImport::prepare_file_import(
			s.config_directory.to_string_lossy().as_ref(),
			"thirdId",
			vec![
				s.reply_path.clone(),
				s.mbox_path.clone(),
				s.msg_path.clone(),
			]
			.into_iter(),
		)
		.unwrap();
		let mut eml_files = Importer::eml_files_in_directory(&import_directory).unwrap();
		eml_files.sort();
		if let [reply_path, mbox_msg_path, mbox_reply_path, msg_path] = eml_files.as_slice() {
			verify_file_contents(
				&[&import_directory, &"0.eml".into()].iter().collect(),
				reply_path,
				EML_REPLY,
			);
			verify_file_contents(
				&[&import_directory, &"1.eml".into()].into_iter().collect(),
				mbox_msg_path,
				EML_MSG,
			);
			verify_file_contents(
				&[&import_directory, &"2.eml".into()].iter().collect(),
				mbox_reply_path,
				EML_REPLY,
			);
			verify_file_contents(
				&[&import_directory, &"3.eml".into()].into_iter().collect(),
				msg_path,
				EML_MSG,
			);
		} else {
			panic!("unexpected eml files {:?}", eml_files);
		}
	}

	fn verify_file_contents(
		expected_path: &PathBuf,
		actual_path: &PathBuf,
		expected_contents: &str,
	) {
		assert_eq!(expected_path, actual_path);
		let msg = String::from_utf8(fs::read(actual_path).unwrap()).unwrap();
		assert_eq!(expected_contents.trim(), msg.trim());
	}

	#[tokio::test]
	async fn should_remove_previous_emls_while_preparing_new_import() {
		let config_dir_string = "/tmp/should_remove_previous_emls_while_preparing_new_import";
		let mailbox_id = "some_mailbox_id";
		let import_dir: PathBuf = [
			config_dir_string.to_string(),
			"current_imports".to_string(),
			mailbox_id.to_string(),
		]
		.iter()
		.collect();

		fs::create_dir_all(&import_dir).unwrap();

		let leftover_eml = import_dir.join("old-1.eml");
		let state_file = import_dir.join(STATE_ID_FILE_NAME);
		fs::write(&state_file, "list-id/element-id").unwrap();
		fs::write(leftover_eml.as_path(), "sample mail").unwrap();

		let result = Importer::get_existing_import_id(&import_dir).unwrap();
		assert_eq!(
			result,
			Some(IdTupleGenerated::new(
				GeneratedId(String::from("list-id")),
				GeneratedId(String::from("element-id"))
			))
		);

		FileImport::prepare_file_import(config_dir_string, mailbox_id, std::iter::empty()).unwrap();

		assert!(!state_file.exists());
		assert!(!leftover_eml.exists());
	}
}
