//! The anonymous install ID the update check carries.
//!
//! A random UUID v4, made the first time Time checks for updates and kept in a
//! plain file beside the database. It is not derived from the user, the
//! account, the hardware, or anything Time records, so it can tell one copy of
//! Time from another and nothing more: the website counts which IDs checked in
//! on each day, which is what separates a few returning installs from many
//! one-time ones. Deleting the file makes a new one; switching update checks
//! off stops the request it rides on.
//!
//! Every failure resolves to `None`, and the check then goes out without an ID
//! rather than with a throwaway one. An ID that cannot be saved would be a new
//! "install" on every launch, which is worse for the count than no ID at all.

use std::fs;
use std::path::{Path, PathBuf};

use uuid::{Uuid, Version};

/// The request header the ID travels in. The website reads the same name in
/// functions/lib/updateCheck.ts; change both or neither.
pub const INSTALL_ID_HEADER: &str = "Time-Install-Id";

const FILE_NAME: &str = "install-id";

/// Beside the database, so it lives and dies with the rest of Time's data.
pub fn install_id_path(database: &Path) -> Option<PathBuf> {
    Some(database.parent()?.join(FILE_NAME))
}

/// The stored ID, or a new one written in its place when the file is missing or
/// holds anything but a v4 UUID. Always returned lowercase and hyphenated, the
/// only form the website accepts.
pub fn load_or_create(path: &Path) -> Option<String> {
    if let Some(existing) = fs::read_to_string(path).ok().and_then(|text| parse(&text)) {
        return Some(existing);
    }
    let id = Uuid::new_v4().hyphenated().to_string();
    save(path, &id).ok()?;
    Some(id)
}

fn parse(text: &str) -> Option<String> {
    let id = Uuid::parse_str(text.trim()).ok()?;
    (id.get_version() == Some(Version::Random)).then(|| id.hyphenated().to_string())
}

/// Written to a sibling and renamed into place, so a crash mid-write leaves
/// either the old file or none, never a truncated ID that would be replaced
/// (and counted as a new install) on the next launch.
fn save(path: &Path, id: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension("tmp");
    fs::write(&staging, id)?;
    fs::rename(&staging, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("time-install-id-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_once_and_then_keeps_the_same_id() {
        let dir = scratch("stable");
        let path = dir.join(FILE_NAME);
        let first = load_or_create(&path).expect("an ID is created");
        let second = load_or_create(&path).expect("the ID is read back");
        assert_eq!(first, second);
        assert_eq!(parse(&first).as_deref(), Some(first.as_str()));
        assert_eq!(first, first.to_lowercase());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_the_data_directory_when_missing() {
        let dir = scratch("missing-parent");
        let path = dir.join("Time").join("Data").join(FILE_NAME);
        assert!(load_or_create(&path).is_some());
        assert!(path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn replaces_a_file_that_is_not_a_v4_uuid() {
        let dir = scratch("garbage");
        let path = dir.join(FILE_NAME);
        for bad in ["not an id", "", "00000000-0000-1000-8000-000000000000"] {
            fs::write(&path, bad).unwrap();
            let id = load_or_create(&path).expect("a replacement is written");
            assert_ne!(id, bad);
            assert_eq!(fs::read_to_string(&path).unwrap(), id);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn normalizes_a_stored_id_with_whitespace_or_uppercase() {
        let dir = scratch("normalize");
        let path = dir.join(FILE_NAME);
        let id = Uuid::new_v4().hyphenated().to_string();
        fs::write(&path, format!("  {}\r\n", id.to_uppercase())).unwrap();
        assert_eq!(load_or_create(&path), Some(id));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn returns_none_rather_than_a_throwaway_id_when_it_cannot_save() {
        let dir = scratch("unwritable");
        // A file where the directory should be: nothing can be created inside it.
        let blocker = dir.join("blocker");
        fs::write(&blocker, "").unwrap();
        assert_eq!(load_or_create(&blocker.join(FILE_NAME)), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lives_beside_the_database() {
        let database = Path::new("C:/Users/someone/AppData/Local/Time/Data/database.db");
        assert_eq!(
            install_id_path(database),
            Some(Path::new("C:/Users/someone/AppData/Local/Time/Data").join(FILE_NAME))
        );
    }
}
