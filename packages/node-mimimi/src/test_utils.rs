use std::fs;
use std::path::PathBuf;

pub(super) struct CleanDir {
	pub dir: PathBuf,
}
impl Drop for CleanDir {
	fn drop(&mut self) {
		if self.dir.exists() {
			fs::remove_dir_all(&self.dir).unwrap();
		}
	}
}
